"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TpuConnection = exports.LeaderTpuService = exports.TpuClient = exports.RecentLeaderSlots = exports.MAX_FANOUT_SLOTS = exports.DEFAULT_FANOUT_SLOTS = exports.MAX_SLOT_SKIP_DISTANCE = exports.LeaderTpuCache = void 0;
const web3_js_1 = require("@solana/web3.js");
const denque_1 = __importDefault(require("denque"));
const quic_1 = require("@matrixai/quic");
const logger_1 = __importDefault(require("@matrixai/logger"));
const peculiarWebcrypto = __importStar(require("@peculiar/webcrypto"));
const bs58_1 = __importDefault(require("bs58"));
const selfsigned_1 = __importDefault(require("selfsigned"));
// create self signed pems for quic
const pems = selfsigned_1.default.generate([{ name: 'commonName', value: 'Solana node' }, { name: "subjectAltName", value: [{ type: 7, value: "0.0.0.0" }] }], { days: 365, algorithm: 'ed25519', keySize: 2048 });
class LeaderTpuCache {
    leaderTpuMap;
    connection;
    first_slot;
    slots_in_epoch;
    last_epoch_info_slot;
    leaders;
    constructor(connection, startSlot) {
        this.connection = connection;
        this.first_slot = startSlot;
    }
    static load(connection, startSlot) {
        return new Promise((resolve) => {
            const leaderTpuCache = new LeaderTpuCache(connection, startSlot);
            leaderTpuCache.connection.getEpochInfo().then(epochInfo => {
                leaderTpuCache.slots_in_epoch = epochInfo.slotsInEpoch;
                leaderTpuCache.fetchSlotLeaders(leaderTpuCache.first_slot, leaderTpuCache.slots_in_epoch).then((leaders) => {
                    leaderTpuCache.leaders = leaders;
                    leaderTpuCache.fetchClusterTpuSockets().then(leaderTpuMap => {
                        leaderTpuCache.leaderTpuMap = leaderTpuMap;
                        resolve(leaderTpuCache);
                    });
                });
            });
        });
    }
    fetchClusterTpuSockets() {
        return new Promise((resolve, reject) => {
            const map = new Map();
            this.connection.getClusterNodes().then(contactInfo => {
                contactInfo.forEach(contactInfo => {
                    // @ts-ignore
                    map.set(contactInfo.pubkey, contactInfo.tpuQuic);
                });
                resolve(map);
            }).catch(error => {
                reject(error);
            });
        });
    }
    fetchSlotLeaders(start_slot, slots_in_epoch) {
        const fanout = Math.min((2 * exports.MAX_FANOUT_SLOTS), slots_in_epoch);
        return this.connection.getSlotLeaders(start_slot, fanout);
    }
    lastSlot() {
        return this.first_slot + this.leaders.length - 1;
    }
    getSlotLeader(slot) {
        if (slot >= this.first_slot) {
            const index = slot - this.first_slot;
            return this.leaders[index];
        }
        else {
            return null;
        }
    }
    getLeaderSockets(fanout_slots) {
        return new Promise((resolve) => {
            const leaderSet = new Set();
            const leaderSockets = new Array();
            let checkedSlots = 0;
            this.leaders.forEach((leader) => {
                const tpu_socket = this.leaderTpuMap.get(leader.toBase58());
                if (tpu_socket !== undefined && tpu_socket !== null) {
                    if (!leaderSet.has(leader.toBase58())) {
                        leaderSet.add(leader.toBase58());
                        leaderSockets.push(tpu_socket);
                    }
                }
                else {
                    console.log('TPU not available for leader: ', leader.toBase58());
                }
                checkedSlots++;
                if (checkedSlots === fanout_slots) {
                    resolve(leaderSockets);
                }
            });
        });
    }
}
exports.LeaderTpuCache = LeaderTpuCache;
exports.MAX_SLOT_SKIP_DISTANCE = 48;
exports.DEFAULT_FANOUT_SLOTS = 12;
exports.MAX_FANOUT_SLOTS = 100;
class RecentLeaderSlots {
    recent_slots;
    //@ts-check
    /**
     *
     * @param current_slot {number}
     */
    constructor(current_slot) {
        this.recent_slots = new denque_1.default();
        this.recent_slots.push(current_slot);
    }
    //@ts-check
    /**
     *
     * @param current_slot {number}
     */
    recordSlot(current_slot) {
        this.recent_slots.push(current_slot);
        while (this.recent_slots.length > 12) {
            this.recent_slots.pop();
        }
    }
    //@ts-check
    /**
     *
     * @returns {number}
     */
    estimatedCurrentSlot() {
        if (this.recent_slots.isEmpty()) {
            throw new Error('recent slots is empty');
        }
        const sortedRecentSlots = this.recent_slots.toArray().sort((a, b) => a - b);
        const max_index = sortedRecentSlots.length - 1;
        const median_index = max_index / 2;
        const median_recent_slot = sortedRecentSlots[median_index];
        const expected_current_slot = median_recent_slot + (max_index - median_index);
        const max_reasonable_current_slot = expected_current_slot + exports.MAX_SLOT_SKIP_DISTANCE;
        return sortedRecentSlots.reverse().find(slot => slot <= max_reasonable_current_slot);
    }
}
exports.RecentLeaderSlots = RecentLeaderSlots;
class TpuClient {
    fanoutSlots;
    leaderTpuService;
    exit;
    connection;
    //@ts-check
    /**
     * @param connection {Connection}
     * @param config {TpuClientConfig}
     */
    constructor(connection, config = { fanoutSlots: exports.DEFAULT_FANOUT_SLOTS }) {
        this.connection = connection;
        this.exit = false;
        this.fanoutSlots = Math.max(Math.min(config.fanoutSlots, exports.MAX_FANOUT_SLOTS), 1);
        console.log('started tpu client');
    }
    //@ts-check
    /**
     * @param connection {Connection}
     * @param websocketUrl {string}
     * @param config {TpuClientConfig}
     * @returns {Promise<TpuClient>}
     */
    static load(connection, websocketUrl = '', config = { fanoutSlots: exports.DEFAULT_FANOUT_SLOTS }) {
        return new Promise((resolve) => {
            const tpuClient = new TpuClient(connection, config);
            LeaderTpuService.load(tpuClient.connection, websocketUrl).then((leaderTpuService) => {
                tpuClient.leaderTpuService = leaderTpuService;
                resolve(tpuClient);
            });
        });
    }
    //@ts-check
    /**
     * @param transaction {Transaction}
     * @param signers {Array<Signer>}
     * @returns {Promise<string>}
     */
    async sendTransaction(transaction, signersOrOptions, _options) {
        if ('version' in transaction) {
            if (signersOrOptions && Array.isArray(signersOrOptions)) {
                throw new Error('Invalid arguments');
            }
            const rawTransaction = transaction.serialize();
            return this.sendRawTransaction(rawTransaction);
        }
        if (signersOrOptions === undefined || !Array.isArray(signersOrOptions)) {
            throw new Error('Invalid arguments');
        }
        const signers = signersOrOptions;
        if (transaction.nonceInfo) {
            transaction.sign(...signers);
        }
        else {
            const latestBh = (await this.connection.getLatestBlockhash());
            transaction.recentBlockhash = latestBh.blockhash;
            transaction.sign(...signers);
        }
        const rawTransaction = transaction.serialize();
        return this.sendRawTransaction(rawTransaction);
    }
    /**
     *
     * @param transaction
     * @param signersOrOptions
     * @param _options
     * @returns
     */
    async sendAbortableTransaction(transaction, signersOrOptions, _options) {
        if ('version' in transaction) {
            if (signersOrOptions && Array.isArray(signersOrOptions)) {
                throw new Error('Invalid arguments');
            }
            const rawTransaction = transaction.serialize();
            return this.sendAbortableRawTransaction(rawTransaction);
        }
        if (signersOrOptions === undefined || !Array.isArray(signersOrOptions)) {
            throw new Error('Invalid arguments');
        }
        const signers = signersOrOptions;
        if (transaction.nonceInfo) {
            transaction.sign(...signers);
            const rawTransaction = transaction.serialize();
            const { signature, abortControllers } = await this.sendAbortableRawTransaction(rawTransaction);
            return { signature, abortControllers };
        }
        else {
            const latestBh = (await this.connection.getLatestBlockhash());
            transaction.recentBlockhash = latestBh.blockhash;
            transaction.sign(...signers);
            const rawTransaction = transaction.serialize();
            const { signature, abortControllers } = await this.sendAbortableRawTransaction(rawTransaction);
            return { signature, abortControllers, blockhash: { ...latestBh } };
        }
    }
    /**
     * @param tpu_address
     * @param logger
     * @param webcrypto
     * @param rawTransaction
     * @param abortController
     * @param retryCount
     * @param retryMaxCount
     * @returns
     */
    async sendSignedRawTransactionToQuicAddress(tpu_address, logger, webcrypto, rawTransaction, abortController, retryCount = 0, retryMaxCount = 2) {
        try {
            if (retryCount > 0) {
                console.log('retrying ' + tpu_address);
            }
            const client = await quic_1.QUICClient.createQUICClient({
                logger,
                config: {
                    key: pems.private,
                    cert: pems.cert,
                    verifyPeer: false,
                    applicationProtos: ['solana-tpu'],
                },
                serverName: "server",
                host: tpu_address.split(':')[0],
                port: parseInt(tpu_address.split(':')[1]),
                crypto: {
                    ops: {
                        randomBytes: async (data) => {
                            webcrypto.getRandomValues(new Uint8Array(data));
                        },
                    },
                }
            });
            // solana-quic doesnt support bidirectional streams
            const clientStream = client.connection.newStream('uni');
            // console.log('getting stream writer', index);
            const writer = clientStream.writable.getWriter();
            // console.log('writing to stream', index);
            await writer.write(Uint8Array.from(rawTransaction));
            await writer.close();
            if (abortController) {
                abortController.signal.addEventListener('abort', () => {
                    if (writer) {
                        if (!writer.closed) {
                            writer.close();
                        }
                    }
                    if (client) {
                        client.destroy();
                    }
                });
            }
            // console.log('closed', index);
        }
        catch (error) {
            if (abortController) {
                if (!abortController.signal.aborted) {
                    if (error.data.errorCode === 2) {
                        console.error('connection refused', tpu_address);
                    }
                    else if (error.data.errorCode === 11) {
                        console.error('invalid token', tpu_address);
                    }
                    else if (error.data.errorCode === 1) {
                        console.error('internal error', tpu_address);
                    }
                    else {
                        console.error('error', tpu_address);
                        console.error(error);
                        console.error(new TextDecoder().decode(error.data.reason));
                    }
                    if (retryCount < retryMaxCount) {
                        return await this.sendSignedRawTransactionToQuicAddress(tpu_address, logger, webcrypto, rawTransaction, abortController, retryCount + 1, retryMaxCount);
                    }
                    else {
                        console.warn('max retry count', tpu_address);
                    }
                }
            }
            else {
                // If no abort controller
                if (error.data.errorCode === 2) {
                    console.error('connection refused', tpu_address);
                }
                else if (error.data.errorCode === 11) {
                    console.error('invalid token', tpu_address);
                }
                else if (error.data.errorCode === 1) {
                    console.error('internal error', tpu_address);
                }
                else {
                    console.error('error', tpu_address);
                    console.error(error);
                    console.error(new TextDecoder().decode(error.data.reason));
                }
                if (retryCount < retryMaxCount) {
                    return await this.sendSignedRawTransactionToQuicAddress(tpu_address, logger, webcrypto, rawTransaction, null, retryCount + 1, retryMaxCount);
                }
                else {
                    console.warn('max retry count', tpu_address);
                }
            }
        }
    }
    /**
     *
     * @param rawTransaction
     * @returns
     */
    async sendAbortableRawTransaction(rawTransaction) {
        const message = web3_js_1.Transaction.from(rawTransaction);
        const signature = bs58_1.default.encode(Uint8Array.from(message.signature));
        const tpu_addresses = await this.leaderTpuService.leaderTpuSockets(this.fanoutSlots);
        const logger = new logger_1.default(signature, 4);
        const webcrypto = new peculiarWebcrypto.Crypto();
        // console.log('sending abortable ' + `https://solscan.io/tx/${signature}` + ' via QUIC');
        // console.log(tpu_addresses.length, 'addresses');
        const abortControllers = tpu_addresses.map((tpu_address) => {
            const abortController = new AbortController();
            this.sendSignedRawTransactionToQuicAddress(tpu_address, logger, webcrypto, rawTransaction, abortController);
            return abortController;
        });
        return { signature, abortControllers };
    }
    //@ts-check
    /**
     *
     * @param rawTransaction {Buffer | number[] | Uint8ARray}
     * @returns {Promise<string>}
     */
    async sendRawTransaction(rawTransaction) {
        const rawTxBuf = Buffer.from(rawTransaction);
        const message = web3_js_1.VersionedTransaction.deserialize(rawTxBuf);
        const signature = bs58_1.default.encode(message.signatures[0]);
        const tpu_addresses = await this.leaderTpuService.leaderTpuSockets(this.fanoutSlots);
        const logger = new logger_1.default(signature, 4);
        const webcrypto = new peculiarWebcrypto.Crypto();
        // console.log('sending ' + `https://solscan.io/tx/${signature}` + ' via QUIC');
        // console.log(tpu_addresses.length, 'addresses');
        tpu_addresses.forEach(async (tpu_address) => {
            this.sendSignedRawTransactionToQuicAddress(tpu_address, logger, webcrypto, rawTransaction);
        });
        return signature;
    }
}
exports.TpuClient = TpuClient;
class LeaderTpuService {
    recentSlots;
    leaderTpuCache;
    subscription;
    connection;
    //@ts-check
    /**
     *
     * @param connection {Connection}
     */
    constructor(connection) {
        this.connection = connection;
    }
    //@ts-check
    /**
     *
     * @param connection {Connection}
     * @param websocket_url {string}
     * @returns {Promise<LeaderTpuService>}
     */
    static load(connection, websocket_url = '') {
        return new Promise((resolve) => {
            const leaderTpuService = new LeaderTpuService(connection);
            leaderTpuService.connection.getSlot('processed').then((start_slot) => {
                leaderTpuService.recentSlots = new RecentLeaderSlots(start_slot);
                LeaderTpuCache.load(connection, start_slot).then(leaderTpuCache => {
                    leaderTpuService.leaderTpuCache = leaderTpuCache;
                    if (websocket_url !== '') {
                        leaderTpuService.subscription = connection.onSlotUpdate((slotUpdate) => {
                            if (slotUpdate.type === 'completed') {
                                slotUpdate.slot++;
                            }
                            leaderTpuService.recentSlots.recordSlot(slotUpdate.slot);
                        });
                    }
                    else {
                        leaderTpuService.subscription = null;
                    }
                    leaderTpuService.run();
                    resolve(leaderTpuService);
                });
            });
        });
    }
    //@ts-check
    /**
     *
     * @param fanout_slots {number}
     * @returns {Promise<string[]>}
     */
    leaderTpuSockets(fanout_slots) {
        return this.leaderTpuCache.getLeaderSockets(fanout_slots);
    }
    //@ts-check
    /**
     * @returns {void}
     */
    async run() {
        const last_cluster_refresh = Date.now();
        let sleep_ms = 1000;
        setTimeout(async () => {
            sleep_ms = 1000;
            if (Date.now() - last_cluster_refresh > (1000 * 5 * 60)) {
                try {
                    this.leaderTpuCache.leaderTpuMap = await this.leaderTpuCache.fetchClusterTpuSockets();
                }
                catch (error) {
                    console.warn('Failed to fetch cluster tpu sockets', error);
                    sleep_ms = 1000;
                }
            }
            const estimatedCurrentSlot = this.recentSlots.estimatedCurrentSlot();
            if (estimatedCurrentSlot >= this.leaderTpuCache.last_epoch_info_slot - this.leaderTpuCache.slots_in_epoch) {
                try {
                    const epochInfo = await this.connection.getEpochInfo('recent');
                    this.leaderTpuCache.slots_in_epoch = epochInfo.slotsInEpoch;
                    this.leaderTpuCache.last_epoch_info_slot = estimatedCurrentSlot;
                }
                catch (error) {
                    console.warn('failed to get epoch info');
                }
            }
            if (estimatedCurrentSlot >= (this.leaderTpuCache.lastSlot() - exports.MAX_FANOUT_SLOTS)) {
                try {
                    const slot_leaders = await this.leaderTpuCache.fetchSlotLeaders(estimatedCurrentSlot, this.leaderTpuCache.slots_in_epoch);
                    this.leaderTpuCache.first_slot = estimatedCurrentSlot;
                    this.leaderTpuCache.leaders = slot_leaders;
                }
                catch (error) {
                    console.warn(`Failed to fetch slot leaders (current estimated slot: ${estimatedCurrentSlot})`, error);
                    sleep_ms = 1000;
                }
            }
            this.run();
        }, sleep_ms);
    }
}
exports.LeaderTpuService = LeaderTpuService;
class TpuConnection extends web3_js_1.Connection {
    tpuClient;
    //@ts-check
    /**
     *
     * @param endpoint {string}
     * @param commitmentOrConfig {Commitment | ConnectionConfig}
     */
    constructor(endpoint, commitmentOrConfig) {
        super(endpoint, commitmentOrConfig);
    }
    //@ts-check
    /**
     *
     * @param transaction {Transaction}
     * @param signers {Array<Signer>}
     * @returns {Promise<string>}
     */
    sendTransaction(transaction, signers, sendOptions) {
        return this.tpuClient.sendTransaction(transaction, signers, sendOptions);
    }
    /**
     *
     * @param transaction
     * @param signers
     * @param sendOptions
     * @returns
     */
    sendAbortableTransaction(transaction, signers, sendOptions) {
        return this.tpuClient.sendAbortableTransaction(transaction, signers, sendOptions);
    }
    /**
     *
     * @param rawTransaction {Buffer | Array<number> | Uint8Array}
     * @returns {Promise<string>}
     */
    sendRawTransaction(rawTransaction) {
        return this.tpuClient.sendRawTransaction(rawTransaction);
    }
    /**
     *
     * @param rawTransaction
     * @returns
     */
    sendAbortableRawTransaction(rawTransaction) {
        return this.tpuClient.sendAbortableRawTransaction(rawTransaction);
    }
    ///@ts-check
    /**
     *
     * @param connection {TpuConnection}
     * @param transaction {Transaction}
     * @param signers {Array<Signer>}
     * @param options {ConfirmOptions}
     * @returns {Promise<TransactionSignature>}
     */
    async sendAndConfirmTransaction(transaction, signers, options) {
        const signature = await this.sendTransaction(transaction, signers);
        const status = (await this.confirmTransaction(signature, options.commitment)).value;
        if (status.err) {
            throw new Error(`Transaction ${signature} failed (${JSON.stringify(status)})`);
        }
        else {
            console.log(`Transaction Confirmed https://solana.fm/tx/${signature}`);
        }
        return signature;
    }
    //@ts-check
    /**
     *
     * @param connection {TpuConnection}
     * @param rawTransaction {Buffer | Array<number> | Uint8Array}
     * @param options {ConfirmOptions}
     * @returns {Promise<string>}
     */
    async sendAndConfirmRawTransaction(rawTransaction, options) {
        const signature = await this.sendRawTransaction(rawTransaction);
        const status = (await this.confirmTransaction(signature, options.commitment)).value;
        if (status.err) {
            throw new Error(`Transaction ${signature} failed (${JSON.stringify(status)})`);
        }
        else {
            console.log(`Transaction Confirmed https://solana.fm/tx/${signature}`);
        }
        return signature;
    }
    /**
     *
     * @param transaction
     * @param signers
     * @param sendOptions
     * @returns
     */
    async sendAndConfirmAbortableTransaction(transaction, signers, sendOptions) {
        const { signature, abortControllers, blockhash } = await this.tpuClient.sendAbortableTransaction(transaction, signers, sendOptions);
        console.log(`sent tx: https://solana.fm/tx/${signature}`);
        try {
            if (!('version' in transaction)) {
                let status;
                if (blockhash) {
                    try {
                        status = (await this.confirmTransaction({ signature, ...blockhash }, 'processed')).value;
                    }
                    catch (error) {
                        if (error instanceof web3_js_1.TransactionExpiredBlockheightExceededError) {
                            return await this.sendAndConfirmAbortableTransaction(transaction, signers, sendOptions);
                        }
                    }
                }
                else {
                    status = (await this.confirmTransaction(signature, 'processed')).value;
                }
                if (status.err === null) {
                    console.log(`Transaction Processed https://solana.fm/tx/${signature}`);
                    abortControllers.forEach(controller => controller.abort());
                    return signature;
                }
                else {
                    console.error(status.err);
                    abortControllers.forEach(controller => controller.abort());
                }
            }
        }
        catch (error) {
            console.error(error);
        }
        return signature;
    }
    /**
     *
     * @param rawTransaction
     * @param blockhash
     * @returns
     */
    async sendAndConfirmAbortableRawTransaction(rawTransaction, blockhash) {
        const { signature, abortControllers } = await this.tpuClient.sendAbortableRawTransaction(rawTransaction);
        let status;
        if (blockhash) {
            status = (await this.confirmTransaction({ signature, ...blockhash }, 'processed')).value;
        }
        else {
            status = (await this.confirmTransaction(signature, 'processed')).value;
        }
        if (status.err === null) {
            console.log(`Transaction Processed https://solana.fm/tx/${signature}`);
            abortControllers.forEach(controller => controller.abort());
            return signature;
        }
        else {
            console.error(status.err);
            abortControllers.forEach(controller => controller.abort());
        }
    }
    //@ts-check
    /**
     *
     * @param endpoint {string}
     * @param commitmentOrConfig {Commitment | ConnectionConfig}
     * @returns {Promise<TpuConnection>}
     */
    static load(endpoint, commitmentOrConfig) {
        return new Promise((resolve) => {
            const tpuConnection = new TpuConnection(endpoint, commitmentOrConfig);
            TpuClient.load(tpuConnection).then(tpuClient => {
                tpuConnection.tpuClient = tpuClient;
                resolve(tpuConnection);
            });
        });
    }
}
exports.TpuConnection = TpuConnection;
//# sourceMappingURL=index.js.map