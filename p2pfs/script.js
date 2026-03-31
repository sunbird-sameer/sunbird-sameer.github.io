const App = {
    peer: null,
    connection: null,
    myId: null,
    targetId: null,
    CHUNK_SIZE: 64 * 1024, // 64 KB (safer for data channel limits)
    MAX_BUFFER: 8 * 1024 * 1024, // 8 MB backpressure limit
    incomingBatches: {}, // { batchId: { meta, files: { fileId: { meta, chunks, received } } } }
    transfers: {} // Tracks UI elements
};

// DOM Elements
const els = {
    myIdDisplay: document.getElementById('my-id'),
    copyBtn: document.getElementById('copy-id-btn'),
    targetIdInput: document.getElementById('target-id'),
    connectBtn: document.getElementById('connect-btn'),
    statusBadge: document.getElementById('connection-status'),
    statusText: document.getElementById('status-text'),
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    folderInput: document.getElementById('folder-input'),
    transfersContainer: document.getElementById('transfers-container')
};

// Initialize Icons
lucide.createIcons();

// --- Initialization & PeerJS ---

function init() {
    const id = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    App.peer = new Peer(id, { debug: 1 });

    App.peer.on('open', (peerId) => {
        App.myId = peerId;
        els.myIdDisplay.textContent = peerId;
    });

    App.peer.on('connection', (conn) => {
        if (App.connection) {
            conn.close();
            return;
        }
        setupConnection(conn);
    });

    App.peer.on('error', (err) => {
        console.error('Peer error:', err);
        updateStatus(false, 'Connection Error');
    });

    setupEventListeners();
}

function connectToPeer(targetId) {
    if (!targetId || targetId === App.myId) return;
    
    updateStatus(false, 'Connecting...');
    const conn = App.peer.connect(targetId, { reliable: true });
    
    conn.on('open', () => {
        setupConnection(conn);
    });
}

function setupConnection(conn) {
    App.connection = conn;
    
    updateStatus(true, 'Connected to ' + conn.peer);
    enableDropZone();

    conn.on('data', handleIncomingData);
    
    conn.on('close', () => {
        App.connection = null;
        updateStatus(false, 'Disconnected');
        disableDropZone();
    });
}

// --- Data Handling (Receiving) ---

function handleIncomingData(data) {
    if (data.type === 'BATCH_META') {
        App.incomingBatches[data.batchId] = {
            meta: data,
            files: {},
            receivedFiles: 0,
            receivedBytesTotal: 0
        };
        createBatchUI(data.batchId, data.name, 'incoming', data.totalFiles);
    } 
    else if (data.type === 'FILE_META') {
        const batch = App.incomingBatches[data.batchId];
        if (!batch) return;
        
        batch.files[data.fileId] = {
            meta: data,
            chunks: [],
            receivedBytes: 0,
            receivedChunks: 0,
            completedNum: 0
        };
        addSubFileUI(data.batchId, data.fileId, data.name);
    } 
    else if (data.type === 'FILE_CHUNK') {
        const batch = App.incomingBatches[data.batchId];
        if (!batch) return;
        const fileData = batch.files[data.fileId];
        if (!fileData) return;

        fileData.chunks[data.chunkIndex] = data.payload;
        fileData.receivedChunks++;
        fileData.receivedBytes += data.payload.byteLength || data.payload.size || data.payload.length;
        batch.receivedBytesTotal += data.payload.byteLength || data.payload.size || data.payload.length;

        // Individual file progress
        const filePct = (fileData.receivedChunks / fileData.meta.totalChunks) * 100;
        updateSubFileProgress(data.batchId, data.fileId, filePct);

        // Batch progress
        const batchPct = (batch.receivedBytesTotal / batch.meta.totalSize) * 100;
        updateTransferProgress(data.batchId, batchPct);

        if (fileData.receivedChunks === fileData.meta.totalChunks) {
            finishReceivingFile(data.batchId, data.fileId);
        }
    }
}

function finishReceivingFile(batchId, fileId) {
    const batch = App.incomingBatches[batchId];
    const fileData = batch.files[fileId];
    
    const blob = new Blob(fileData.chunks, { type: fileData.meta.fileType });
    fileData.blob = blob; // Keep reference for Zip
    
    const url = URL.createObjectURL(blob);
    showSubFileDownload(batchId, fileId, url, fileData.meta.name);
    
    // Clean chunks to save array memory, keep blob
    fileData.chunks = []; 
    
    batch.receivedFiles++;
    
    if (batch.receivedFiles === batch.meta.totalFiles) {
        finishReceivingBatch(batchId);
    }
}

async function finishReceivingBatch(batchId) {
    const batch = App.incomingBatches[batchId];
    updateTransferProgress(batchId, 100);
    markTransferComplete(batchId, 'Received Successfully', true);

    if (batch.meta.totalFiles > 1 && window.JSZip) {
        // Create Zip
        const zip = new JSZip();
        Object.values(batch.files).forEach(f => {
            zip.file(f.meta.name, f.blob);
        });

        const zipBlob = await zip.generateAsync({ type: "blob" });
        const zipUrl = URL.createObjectURL(zipBlob);
        showBatchDownload(batchId, zipUrl, `${batch.meta.name}.zip`);
    } else if (batch.meta.totalFiles === 1) {
        // Single file, main ui button triggers the single file
        const fileData = Object.values(batch.files)[0];
        const url = URL.createObjectURL(fileData.blob);
        showBatchDownload(batchId, url, fileData.meta.name.split('/').pop());
    }
}

// --- Sending Logic ---

function handleFilesSelected(fileList) {
    if (!App.connection || !fileList.length) return;
    
    const files = Array.from(fileList);
    const batchId = generateUUID();
    
    // Determine batch name
    let batchName = "Batch Transfer";
    if (files.length === 1) {
        batchName = files[0].name;
    } else {
        // Check if they share a common directory root (folder upload)
        const firstPath = files[0].webkitRelativePath;
        if (firstPath) {
            batchName = firstPath.split('/')[0];
        } else {
            batchName = `${files.length} files`;
        }
    }

    const totalSize = files.reduce((acc, f) => acc + f.size, 0);

    createBatchUI(batchId, batchName, 'outgoing', files.length);

    App.connection.send({
        type: 'BATCH_META',
        batchId: batchId,
        name: batchName,
        totalFiles: files.length,
        totalSize: totalSize
    });

    // Queue files to be sent sequentially to respect buffer limits
    let currentFileIndex = 0;
    let sentBytesTotal = 0;

    const sendNextFile = () => {
        if (currentFileIndex >= files.length) {
            markTransferComplete(batchId, 'Sent Successfully', false);
            return;
        }

        const file = files[currentFileIndex];
        const fileId = generateUUID();
        const fileName = file.webkitRelativePath || file.name;
        const totalChunks = Math.ceil(file.size / App.CHUNK_SIZE);

        addSubFileUI(batchId, fileId, fileName);

        App.connection.send({
            type: 'FILE_META',
            batchId: batchId,
            fileId: fileId,
            name: fileName,
            size: file.size,
            fileType: file.type,
            totalChunks: totalChunks
        });

        if (file.size === 0) {
            updateSubFileProgress(batchId, fileId, 100);
            currentFileIndex++;
            sendNextFile();
            return;
        }

        let offset = 0;
        let chunkIndex = 0;

        const readNextChunk = () => {
            if (offset >= file.size) {
                updateSubFileProgress(batchId, fileId, 100);
                currentFileIndex++;
                sendNextFile();
                return;
            }

            // BACKPRESSURE CHECK
            const dc = App.connection.dataChannel;
            if (dc && dc.bufferedAmount > App.MAX_BUFFER) {
                setTimeout(readNextChunk, 50); // wait until buffer clears
                return;
            }

            const slice = file.slice(offset, offset + App.CHUNK_SIZE);
            const reader = new FileReader();
            
            reader.onload = (e) => {
                App.connection.send({
                    type: 'FILE_CHUNK',
                    batchId: batchId,
                    fileId: fileId,
                    chunkIndex: chunkIndex,
                    payload: e.target.result
                });

                offset += App.CHUNK_SIZE;
                chunkIndex++;
                sentBytesTotal += e.target.result.byteLength;
                
                // Track progress
                const filePct = Math.min(100, (offset / file.size) * 100);
                updateSubFileProgress(batchId, fileId, filePct);
                
                const batchPct = Math.min(100, (sentBytesTotal / totalSize) * 100);
                updateTransferProgress(batchId, batchPct);

                readNextChunk(); // Read next synchronously on loop (prevent callstack explosion via setTimeout occasionally if needed, but FileReader is async)
            };
            
            reader.readAsArrayBuffer(slice);
        };

        readNextChunk();
    };

    sendNextFile();
}

// --- UI Updates ---

function updateStatus(isConnected, text) {
    els.statusText.textContent = text;
    if (isConnected) {
        els.statusBadge.classList.add('connected');
        els.statusBadge.classList.remove('disconnected');
        els.connectBtn.disabled = true;
        els.targetIdInput.disabled = true;
    } else {
        els.statusBadge.classList.remove('connected');
        els.statusBadge.classList.add('disconnected');
        els.connectBtn.disabled = false;
        els.targetIdInput.disabled = false;
    }
}

function enableDropZone() { els.dropZone.classList.remove('disabled'); }
function disableDropZone() { els.dropZone.classList.add('disabled'); }

function createBatchUI(id, name, type, totalFiles) {
    const el = document.createElement('div');
    el.className = 'transfer-item batch-transfer';
    el.id = `transfer-${id}`;
    
    const isIncoming = type === 'incoming';
    const iconClass = isIncoming ? 'incoming' : 'outgoing';
    const iconName = isIncoming ? 'download' : 'upload';
    const actionText = isIncoming ? 'Receiving...' : 'Sending...';

    // Build sub-files container if multiple files
    const subFilesHtml = totalFiles > 1 ? `<div class="batch-files" id="subs-${id}"></div>` : `<div id="subs-${id}" style="display:none;"></div>`;

    el.innerHTML = `
        <div class="batch-header">
            <div class="transfer-icon ${iconClass}">
                <i data-lucide="${iconName}"></i>
            </div>
            <div class="transfer-details">
                <span class="transfer-title" title="${name}">${name} <span style="color:var(--text-muted);font-size:0.8rem;margin-left:8px;">(${totalFiles} file${totalFiles>1?'s':''})</span></span>
                <div class="transfer-meta">
                    <span id="status-${id}">${actionText}</span>
                    <span id="pct-${id}">0%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" id="fill-${id}"></div>
                </div>
            </div>
            <div class="transfer-actions" id="actions-${id}"></div>
        </div>
        ${subFilesHtml}
    `;

    els.transfersContainer.prepend(el);
    lucide.createIcons();
    
    App.transfers[id] = {
        fill: el.querySelector(`#fill-${id}`),
        pct: el.querySelector(`#pct-${id}`),
        status: el.querySelector(`#status-${id}`),
        actions: el.querySelector(`#actions-${id}`),
        subs: el.querySelector(`#subs-${id}`),
        subItems: {}
    };
}

function addSubFileUI(batchId, fileId, name) {
    const ui = App.transfers[batchId];
    if (!ui) return;

    const el = document.createElement('div');
    el.className = 'sub-file-item';
    el.innerHTML = `
        <span class="sub-file-name" title="${name}">${name}</span>
        <span class="sub-file-progress" id="sub-pct-${fileId}">0%</span>
        <div class="sub-file-actions" id="sub-act-${fileId}"></div>
    `;

    ui.subs.appendChild(el);
    ui.subItems[fileId] = {
        pct: el.querySelector(`#sub-pct-${fileId}`),
        act: el.querySelector(`#sub-act-${fileId}`)
    };
}

function updateTransferProgress(id, percentage) {
    const ui = App.transfers[id];
    if (!ui) return;
    const val = isNaN(percentage) ? 0 : percentage.toFixed(0);
    ui.fill.style.width = `${val}%`;
    ui.pct.textContent = `${val}%`;
}

function updateSubFileProgress(batchId, fileId, percentage) {
    const ui = App.transfers[batchId];
    if (!ui || !ui.subItems[fileId]) return;
    const val = isNaN(percentage) ? 0 : percentage.toFixed(0);
    ui.subItems[fileId].pct.textContent = `${val}%`;
}

function markTransferComplete(id, text, isSuccess) {
    const ui = App.transfers[id];
    if (!ui) return;
    ui.status.textContent = text;
    if (isSuccess) ui.fill.style.background = 'var(--success)';
}

function showSubFileDownload(batchId, fileId, url, filename) {
    const ui = App.transfers[batchId];
    if (!ui || !ui.subItems[fileId]) return;
    
    ui.subItems[fileId].pct.style.display = 'none';
    const basename = filename.split('/').pop();
    ui.subItems[fileId].act.innerHTML = `<a href="${url}" download="${basename}">Save</a>`;
}

function showBatchDownload(id, url, filename) {
    const ui = App.transfers[id];
    if (!ui) return;
    
    const isZip = filename.endsWith('.zip');
    const icon = isZip ? 'archive' : 'check-circle';
    const text = isZip ? 'Download All (ZIP)' : 'Save File';

    ui.actions.innerHTML = `
        <a href="${url}" download="${filename}">
            <i data-lucide="${icon}" class="mr-2"></i> ${text}
        </a>
    `;
    lucide.createIcons();
}

// --- Event Listeners & Utilities ---

function setupEventListeners() {
    els.copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(App.myId).then(() => {
            console.log('ID copied');
        });
    });

    els.connectBtn.addEventListener('click', () => {
        const target = els.targetIdInput.value.trim().toUpperCase();
        connectToPeer(target);
    });

    els.targetIdInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') els.connectBtn.click();
    });

    els.dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!els.dropZone.classList.contains('disabled')) els.dropZone.classList.add('drag-over');
    });

    els.dropZone.addEventListener('dragleave', () => {
        els.dropZone.classList.remove('drag-over');
    });

    els.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        els.dropZone.classList.remove('drag-over');
        if (!els.dropZone.classList.contains('disabled')) {
            handleFilesSelected(e.dataTransfer.files);
        }
    });

    els.fileInput.addEventListener('change', (e) => {
        handleFilesSelected(e.target.files);
        e.target.value = ''; 
    });

    els.folderInput.addEventListener('change', (e) => {
        handleFilesSelected(e.target.files);
        e.target.value = ''; 
    });
}

function generateUUID() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Boot
window.addEventListener('DOMContentLoaded', init);
