// === 設定 ===
const CONFIG = {
    LOCATION_TIMEOUT: 20000,
    RECONNECT_BASE_DELAY: 1000,
    RECONNECT_MULTIPLIER: 1.5,
    RECONNECT_MAX_DELAY: 30000,
    CONNECTION_CHECK_INTERVAL: 5000,
    BACKGROUND_UPDATE_INTERVAL: 15000,
    BACKGROUND_KEEPALIVE_INTERVAL: 20000,
    PARTICIPANTS_UPDATE: 2000,
    MAX_TIME_WITHOUT_UPDATE: 30000,
    POSITION_CACHE_DURATION: 7 * 24 * 60 * 60 * 1000,
    MOVEMENT_THRESHOLD: 3,
    MIN_TIME_BETWEEN_UPDATES: 1000, 
    CLUSTERING_DISTANCE: 25,
    CLUSTER_OFFSET_RADIUS: 33,
};

// === ストレージキー ===
const STORAGE_KEYS = {
    SESSION_STATE: `locationSharing_${window.djangoData.sessionId}`,
    STAY_TIME_TRACKER: 'stay_time_tracker'
};

// === 状態管理クラス ===
class LocationSharingState {
    constructor() {
        // 基本状態
        this.isSharing = false;
        this.participantId = null;
        this.persistentParticipantId = null;  // ★ 永続的な参加者ID
        this.sessionFingerprint = null;  // ★ セッションフィンガープリント
        this.sessionExpired = false;
        this.userInteracted = false;
        this.autoFitEnabled = true;
        this.isInBackground = false;
        this.followingParticipantId = null;
        this.isLeaving = false;
        this._leavingProcessStarted = false; 
        
        // 位置情報
        this.lastKnownPosition = null;
        this.lastSentPosition = null;
        this.lastSentTime = 0;
        
        // 接続状態
        this.reconnectAttempts = 0;
        this.backgroundReconnectAttempts = 0;
        this.lastSuccessfulConnection = null;
        this.isReconnecting = false;
        
        // データ
        this.participantsData = [];
        this.participantOrder = [];
        this.participantColors = {};
        this.previousParticipantsState = new Map();
        
        // セッション情報
        this.sessionId = window.djangoData.sessionId;
        this.expiresAt = new Date(window.djangoData.expiresAt);
        this.initPersistentIds();
        this.load();
    }
    initPersistentIds() {
    // 永続的な参加者IDを生成/取得
    const storedPersistentId = localStorage.getItem('persistent_participant_id');
    if (storedPersistentId) {
        this.persistentParticipantId = storedPersistentId;
    } else {
        this.persistentParticipantId = this.generateUUID();
        localStorage.setItem('persistent_participant_id', this.persistentParticipantId);
    }
    
    // セッションフィンガープリントを生成
    this.sessionFingerprint = this.generateSessionFingerprint();
}


generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}


generateSessionFingerprint() {
    const userAgent = navigator.userAgent;
    const language = navigator.language;
    const platform = navigator.platform;
    const screenResolution = `${screen.width}x${screen.height}`;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    const fingerprint = `${userAgent}_${language}_${platform}_${screenResolution}_${timezone}`;
    
    // 簡単なハッシュ関数でフィンガープリントを生成
    let hash = 0;
    for (let i = 0; i < fingerprint.length; i++) {
        const char = fingerprint.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    
    return Math.abs(hash).toString(36);
}
    save() {
        try {
            const stateToSave = {
                isSharing: this.isSharing,
                participantName: this.getParticipantName(),
                lastPosition: this.lastKnownPosition ? {
                    latitude: this.lastKnownPosition.coords.latitude,
                    longitude: this.lastKnownPosition.coords.longitude,
                    accuracy: this.lastKnownPosition.coords.accuracy,
                    timestamp: Date.now()
                } : null,
                savedAt: Date.now(),
                // ★ 参加者管理データも保存
                participantOrder: this.participantOrder || [],
                participantColors: this.participantColors || {},
                followingParticipantId: this.followingParticipantId || null,
                followingGroup: this.followingGroup || null
            };
            
            localStorage.setItem(STORAGE_KEYS.SESSION_STATE, JSON.stringify(stateToSave));
        } catch (error) {
            console.warn('状態保存に失敗:', error);
        }
    }
    
    load() {
    try {
        const savedState = localStorage.getItem(STORAGE_KEYS.SESSION_STATE);
        if (!savedState) return;

        const state = JSON.parse(savedState);
        
        // ★ 参加者管理データを復元
        if (state.participantOrder) {
            this.participantOrder = state.participantOrder;
        }
        if (state.participantColors) {
            this.participantColors = state.participantColors;
        }
        if (state.followingParticipantId) {
            this.followingParticipantId = state.followingParticipantId;
        }
        if (state.followingGroup) {
            this.followingGroup = state.followingGroup;
        }
        
        return state;
    } catch (error) {
        console.warn('状態読み込みに失敗:', error);
        this.clear();
    }
}
    
    clear() {
        try {
            // LocalStorageをクリア
            localStorage.removeItem(STORAGE_KEYS.SESSION_STATE);
            localStorage.removeItem(STORAGE_KEYS.STAY_TIME_TRACKER);
            
            // セッションストレージもクリア
            if (typeof sessionStorage !== 'undefined') {
                const keysToRemove = [];
                for (let i = 0; i < sessionStorage.length; i++) {
                    const key = sessionStorage.key(i);
                    if (key && key.startsWith('locationSharing_')) {
                        keysToRemove.push(key);
                    }
                }
                keysToRemove.forEach(key => sessionStorage.removeItem(key));
            }
            
        } catch (error) {
            console.warn('状態クリアに失敗:', error);
        }
    }

    
    getParticipantName() {
        return ui.elements.participantName?.value || '';
    }
}

// === UI管理クラス ===
class UIManager {
    constructor() {
        this.elements = {};
        this.eventListeners = [];
        this.lastNotificationTime = {};
        this.lastWebSocketStatus = null;
        this.statusChangeTimeout = null;
        this.currentParticipantsHtml = '';
        
        this.initElements();
    }
    
    initElements() {
        this.elements = {
            wsStatus: document.getElementById('websocket-status'),
            locationStatus: document.getElementById('location-status'),
            participantsList: document.getElementById('participants-list'),
            countdown: document.getElementById('countdown'),
            participantName: document.getElementById('participant-name'),
            toggleSharing: document.getElementById('toggle-sharing'),
            sessionStatus: document.getElementById('session-status'),
            lastCommunication: document.getElementById('last-communication')
        };
    }
    
    updateStatus(type, status, message) {
        const element = this.elements[type + 'Status'];
        if (!element) return;

        switch (type) {
            case 'ws':
                this.updateWebSocketStatus(element, status, message);
                break;
            case 'location':
            case 'visibility':
                element.textContent = message;
                element.className = `status-${status}`;
                break;
        }
    }
    
    updateWebSocketStatus(element, status, message) {
        if (this.statusChangeTimeout) {
            clearTimeout(this.statusChangeTimeout);
        }
        
        if (this.lastWebSocketStatus === status) return;
        
        this.statusChangeTimeout = setTimeout(() => {
            this.lastWebSocketStatus = status;
            
            const statusConfig = {
                connected: { class: 'bg-success', indicator: 'connection-good' },
                reconnecting: { class: 'bg-warning', indicator: 'connection-poor' },
                error: { class: 'bg-danger', indicator: 'connection-bad' },
                disconnected: { class: 'bg-danger', indicator: 'connection-bad' }
            };
            
            const config = statusConfig[status] || { class: 'bg-secondary', indicator: '' };
            
            element.innerHTML = `
                <span class="connection-indicator ${config.indicator}"></span>
                <span class="badge ${config.class}">${message}</span>
            `;
            this.statusChangeTimeout = null;
        }, 1000);
    }
    
    showNotification(message, type = 'info', icon = null, preventDuplicates = true) {
        if (preventDuplicates) {
            const now = Date.now();
            const lastTime = this.lastNotificationTime[message] || 0;
            if (now - lastTime < 5000) return;
            this.lastNotificationTime[message] = now;
        }
        
        const alertDiv = this.createNotificationElement(message, type, icon);
        this.positionNotification(alertDiv);
        document.body.appendChild(alertDiv);
        
        setTimeout(() => this.removeNotification(alertDiv), 5000);
    }
    
    createNotificationElement(message, type, icon) {
        const alertDiv = document.createElement('div');
        alertDiv.className = `alert alert-${type} alert-dismissible fade show realtime-notification`;
        
        if (icon) {
            const iconElement = document.createElement('i');
            iconElement.className = `${icon} me-2`;
            alertDiv.appendChild(iconElement);
        }
        
        const messageSpan = document.createElement('span');
        messageSpan.textContent = message;
        alertDiv.appendChild(messageSpan);
        
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'btn-close';
        closeButton.setAttribute('data-bs-dismiss', 'alert');
        alertDiv.appendChild(closeButton);
        
        return alertDiv;
    }
    
    positionNotification(alertDiv) {
        const existingNotifications = document.querySelectorAll('.realtime-notification');
        existingNotifications.forEach((notification) => {
            const currentTop = parseInt(notification.style.top) || 20;
            notification.style.top = (currentTop + 80) + 'px';
        });
        
        Object.assign(alertDiv.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            zIndex: '9999',
            minWidth: '300px',
            maxWidth: '400px'
        });
    }
    
    removeNotification(alertDiv) {
        if (alertDiv.parentNode) {
            alertDiv.remove();
            const remainingNotifications = document.querySelectorAll('.realtime-notification');
            remainingNotifications.forEach((notification) => {
                const currentTop = parseInt(notification.style.top) || 100;
                if (currentTop > 20) {
                    notification.style.top = (currentTop - 80) + 'px';
                }
            });
        }
    }
    
    updateSharingButton() {
        if (!this.elements.toggleSharing) return;
        
        if (state.isSharing) {
            this.elements.toggleSharing.innerHTML = '<i class="fas fa-pause"></i> 共有停止';
            this.elements.toggleSharing.className = 'btn btn-warning';
        } else {
            this.elements.toggleSharing.innerHTML = '<i class="fas fa-play"></i> 共有開始';
            this.elements.toggleSharing.className = 'btn btn-success';
        }
    }
    
    updateCountdown() {
        if (!this.elements.countdown) return;
        
        const now = new Date();
        const timeLeft = state.expiresAt - now;
        
        if (timeLeft <= 0) {
            this.elements.countdown.textContent = '期限切れ';
            sessionManager.handleExpired();
            return;
        }
        
        const hours = Math.floor(timeLeft / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);
        
        this.elements.countdown.textContent = 
            `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    
    addEventListener(element, event, handler, options = {}) {
        if (element) {
            element.addEventListener(event, handler, options);
            this.eventListeners.push({ element, event, handler, options });
        }
    }
    
    cleanup() {
        this.eventListeners.forEach(({ element, event, handler, options }) => {
            if (element && element.removeEventListener) {
                element.removeEventListener(event, handler, options);
            }
        });
        this.eventListeners = [];
    }
}

// === WebSocket管理クラス ===
class WebSocketManager {
    constructor() {
        this.websocket = null;
        this.connectionInterval = null;
        this.backgroundKeepAliveInterval = null;
    }
    
init() {
    // ★ 追加：退出中の場合は初期化しない
    if (state.isLeaving || state.sessionExpired) {
        console.log('退出中のため WebSocket 初期化をスキップ');
        return;
    }
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/location/${state.sessionId}/`;
    
    if (this.websocket) {
        this.websocket.onclose = null;
        this.websocket.close();
        this.websocket = null;
    }
    
    if (!state.isReconnecting) {
        state.isReconnecting = true;
        ui.updateStatus('ws', 'reconnecting', '接続中...');
    }
    
    try {
        this.websocket = new WebSocket(wsUrl);
        this.setupEventHandlers();
    } catch (error) {
        console.error('WebSocket初期化エラー:', error);
        ui.updateStatus('ws', 'error', 'エラー');
        state.isReconnecting = false;
    }
}
    
    setupEventHandlers() {
        this.websocket.onopen = (event) => this.handleOpen(event);
        this.websocket.onmessage = (event) => this.handleMessage(event);
        this.websocket.onclose = (event) => this.handleClose(event);
        this.websocket.onerror = (error) => this.handleError(error);
    }
    
handleOpen(event) {
    // ★ 追加：退出フラグを再度チェック
    const leavingFlag = localStorage.getItem(`leaving_${state.sessionId}`);
    if (state.isLeaving || state.sessionExpired || leavingFlag === 'true') {
        console.log('退出処理中のため join メッセージをスキップ');
        this.websocket.close();
        return;
    }
    
    state.reconnectAttempts = 0;
    state.backgroundReconnectAttempts = 0;
    state.isReconnecting = false;
    state.lastSuccessfulConnection = Date.now();
    
    ui.updateStatus('ws', 'connected', '接続中');
    this.startConnectionManagement();
    
    this.sendJoinMessage();
    
    // チャット履歴を要求
    if (window.chatManager) {
        setTimeout(() => {
            const participantId = state.participantId || window.djangoData.participantId;
            
            wsManager.send({
                type: 'request_chat_history',
                session_id: state.sessionId,
                participant_id: participantId
            });
        }, 500);
    }
    
    if (state.isInBackground) {
        this.startBackgroundKeepAlive();
    }
}
    
    handleMessage(event) {
        try {
            const data = JSON.parse(event.data);
            messageHandler.handle(data);
            state.lastSuccessfulConnection = Date.now();
        } catch (error) {
            console.error('メッセージ解析エラー:', error);
        }
    }
    
    // === WebSocket管理クラス - handleClose メソッドの修正 ===
handleClose(event) {
    this.stopConnectionManagement();
    this.stopBackgroundKeepAlive();
    state.isReconnecting = false;
    
    // 退出中の場合は再接続しない
    if (state.isLeaving || state.sessionExpired) {
        ui.updateStatus('ws', 'disconnected', '切断');
        // ★ 追加：退出中の場合は WebSocket を null にする
        this.websocket = null;
        return;
    }
    
    // ページ閉じによる正常終了の場合
    if (event.code === 1000 && (event.reason === 'page_unload' || event.reason === 'user_leave' || backgroundManager.isPageUnloading)) {
        ui.updateStatus('ws', 'disconnected', '切断');
        return;
    }
    
    // 手動で閉じられた場合も再接続しない
    if (event.wasClean) {
        ui.updateStatus('ws', 'disconnected', '切断');
        return;
    }
    
    // その他の切断の場合は再接続を試行
    this.handleReconnect();
}
    
    handleError(error) {
        console.error('WebSocketエラー:', error);
        state.isReconnecting = false;
        
        if (!state.isInBackground) {
            setTimeout(() => {
                if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
                    ui.updateStatus('ws', 'error', 'エラー');
                }
            }, 1000);
        }
    }
    
handleReconnect() {
    // ★ 追加：退出中または期限切れの場合は再接続しない
    if (state.sessionExpired || state.isLeaving) {
        console.log('退出中のため再接続をスキップ');
        return;
    }
    
    const maxAttempts = state.isInBackground ? 50 : 10;
    const currentAttempts = state.isInBackground ? 
        state.backgroundReconnectAttempts : state.reconnectAttempts;
    
    if (currentAttempts < maxAttempts) {
        if (state.isInBackground) {
            state.backgroundReconnectAttempts++;
        } else {
            state.reconnectAttempts++;
        }
        
        const baseDelay = state.isInBackground ? 3000 : CONFIG.RECONNECT_BASE_DELAY;
        const delay = Math.min(
            baseDelay * Math.pow(1.2, currentAttempts),
            state.isInBackground ? 15000 : CONFIG.RECONNECT_MAX_DELAY
        );
        
        setTimeout(() => {
            // ★ 追加：タイムアウト実行時にも再度チェック
            if (!state.isLeaving && !state.sessionExpired) {
                this.init();
            }
        }, delay);
    }
}
    
    send(data) {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            try {
                this.websocket.send(JSON.stringify(data));
                return true;
            } catch (error) {
                console.error('メッセージ送信エラー:', error);
                return false;
            }
        }
        return false;
    }
    
    // === WebSocket管理クラス - sendJoinMessage メソッドの修正 ===
sendJoinMessage() {
    // ★ 重要：participant_id が未設定の場合は djangoData から取得
    if (!state.participantId) {
        state.participantId = window.djangoData.participantId;
    }
    
    const joinMessage = {
        type: 'join',
        participant_id: state.participantId,
        persistent_participant_id: state.persistentParticipantId,
        session_fingerprint: state.sessionFingerprint,
        participant_name: state.getParticipantName(),
        is_sharing: state.isSharing,
        has_cached_position: !!state.lastKnownPosition,
        initial_status: state.isSharing ? 'sharing' : 'waiting',
        is_background: state.isInBackground,
        is_mobile: this.isMobileDevice(),
        request_existing_check: true,
        page_returning: backgroundManager?.isPageUnloading === false,
        immediate_online: !state.isInBackground,
        priority_connection: !state.isInBackground,
        deduplicate: true  // ★ 重複防止フラグ
    };
    
    this.send(joinMessage);
}
    
startConnectionManagement() {
    if (this.connectionInterval) clearInterval(this.connectionInterval);
    
    const pingInterval = state.isInBackground ? CONFIG.BACKGROUND_KEEPALIVE_INTERVAL : 60000;
    
    this.connectionInterval = setInterval(() => {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            if (!state.isReconnecting) {
                console.warn('WebSocket接続が無効 - 再接続試行');
                this.init();
            }
            return;
        }

        // ★ 修正：現在の移動速度を計算して含める
        let currentSpeed = 0;
        let isMoving = false;
        
        // MapManagerから現在の速度情報を取得
        if (state.participantId && mapManager.speedHistory && mapManager.speedHistory[state.participantId]) {
            const speeds = mapManager.speedHistory[state.participantId];
            if (speeds.length > 0) {
                currentSpeed = speeds[speeds.length - 1]; // 最新の速度
                isMoving = currentSpeed >= 3; // 3km/h以上で移動中と判定
            }
        }

        // Pingデータ送信（速度情報を追加）
        const pingData = {
            type: 'ping',
            participant_id: state.participantId,
            timestamp: Date.now(),
            is_sharing: state.isSharing,
            has_position: !!state.lastKnownPosition,
            is_background: state.isInBackground,
            is_mobile: this.isMobileDevice(),
            keep_connection: true,
            status: state.isSharing ? 'sharing' : 'waiting',
            // ★ 追加：速度情報
            current_speed: currentSpeed,
            is_moving: isMoving
        };
            
        this.send(pingData);
    }, pingInterval);
}
    
    stopConnectionManagement() {
        if (this.connectionInterval) {
            clearInterval(this.connectionInterval);
            this.connectionInterval = null;
        }
    }
    
    startBackgroundKeepAlive() {
        if (this.backgroundKeepAliveInterval) {
            clearInterval(this.backgroundKeepAliveInterval);
        }
        
        const keepAliveInterval = this.isMobileDevice() ? 30000 : 20000;
        
        this.backgroundKeepAliveInterval = setInterval(() => {
            if (state.isInBackground && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                const pingData = {
                    type: 'ping',
                    participant_id: state.participantId,
                    timestamp: Date.now(),
                    is_sharing: state.isSharing,
                    has_position: !!state.lastKnownPosition,
                    is_background: true,
                    is_mobile: this.isMobileDevice(),
                    keep_alive: true,
                    maintain_background: true
                };
                
                this.send(pingData);
            }
        }, keepAliveInterval);
    }
    
    stopBackgroundKeepAlive() {
        if (this.backgroundKeepAliveInterval) {
            clearInterval(this.backgroundKeepAliveInterval);
            this.backgroundKeepAliveInterval = null;
        }
    }
    
    isMobileDevice() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }
}

// === メッセージハンドラークラス ===
class MessageHandler {
handle(data) {
    switch (data.type) {
        case 'location_update':
            this.handleLocationUpdate(data);
            break;
        case 'single_participant_update':
            this.handleSingleParticipantUpdate(data);
            break;
        case 'background_status_change':
            this.handleBackgroundStatusChange(data);
            break;
        case 'notification':
            this.handleNotification(data);
            break;
        case 'session_expired':
            sessionManager.handleExpired();
            break;
        case 'error':
            this.handleError(data);
            break;
        case 'pong':
            this.handlePong(data);
            break;
        case 'participant_confirmed':
            this.handleParticipantConfirmed(data);
            break;
        case 'name_update_response':
            this.handleNameUpdateResponse(data);
            break;
        case 'duplicate_cleanup_response':
            this.handleDuplicateCleanupResponse(data);
            break;
        case 'chat_message':
            chatManager.handleIncomingMessage(data);
            break;
        case 'typing_indicator':
            chatManager.handleTypingIndicator(data);
            break;
        case 'chat_history':
            chatManager.handleChatHistory(data);
            break;
        case 'participant_status_update':
            chatManager.handleParticipantStatusUpdate(data);
            break;
        case 'remove_direction_indicator':  // ★ 追加
            this.handleRemoveDirectionIndicator(data);
            break;
    }
}

// ★ 新規メソッド追加
handleRemoveDirectionIndicator(data) {
    const participantId = data.participant_id;
    
    // 該当参加者の方向指示を削除
    if (mapManager.directionIndicators && mapManager.directionIndicators[participantId]) {
        if (mapManager.map.hasLayer(mapManager.directionIndicators[participantId])) {
            mapManager.map.removeLayer(mapManager.directionIndicators[participantId]);
        }
        delete mapManager.directionIndicators[participantId];
    }
    
    // 移動アニメーションも停止
    if (mapManager.movementTrackers && mapManager.movementTrackers[participantId]) {
        if (mapManager.movementTrackers[participantId].animationId) {
            cancelAnimationFrame(mapManager.movementTrackers[participantId].animationId);
        }
        delete mapManager.movementTrackers[participantId];
    }
}


// MessageHandler クラスの handleSingleParticipantUpdate メソッドを修正
handleSingleParticipantUpdate(data) {
    
    if (!data.participant_data) {
        console.warn('参加者データが空です');
        return;
    }
    
    const participantData = data.participant_data;
    
    // 自分の更新も処理する
    const isOwnUpdate = participantData.participant_id === state.participantId;
    
    if (isOwnUpdate) {
        // ★ 追加：滞在時間の更新をログ出力
        if (participantData.stay_minutes !== undefined) {
            console.log(`自分の滞在時間更新: ${participantData.stay_minutes}分`);
        }
    }
    
    // 参加者データを更新
    const existingIndex = state.participantsData.findIndex(
        p => p.participant_id === participantData.participant_id
    );
    
    if (existingIndex !== -1) {
        // 既存参加者の更新
        const oldData = state.participantsData[existingIndex];
        
        // ★ 追加：滞在時間が変わった場合の処理
        if (oldData.stay_minutes !== participantData.stay_minutes) {
            console.log(`滞在時間変更検出: ${oldData.stay_minutes}分 → ${participantData.stay_minutes}分`);
        }
        
        // ★ 重要：自分以外の状態変化を検出して通知
        if (!isOwnUpdate) {
            // 共有開始/停止の検出
            if (oldData.status === 'sharing' && participantData.status !== 'sharing') {
                ui.showNotification(
                    `${participantData.participant_name.substring(0, 30)}が共有を停止しました`,
                    'warning',
                    'fas fa-pause',
                    true
                );
            } else if (oldData.status !== 'sharing' && participantData.status === 'sharing') {
                ui.showNotification(
                    `${participantData.participant_name.substring(0, 30)}が位置情報を共有しました`,
                    'info',
                    'fas fa-map-marker-alt',
                    true
                );
            }
            
            // オンライン/オフラインの検出
            if (oldData.is_online && !participantData.is_online) {
                ui.showNotification(
                    `${participantData.participant_name.substring(0, 30)}がオフラインになりました`,
                    'secondary',
                    'fas fa-wifi-slash',
                    true
                );
            } else if (!oldData.is_online && participantData.is_online) {
                ui.showNotification(
                    `${participantData.participant_name.substring(0, 30)}が復帰しました`,
                    'success',
                    'fas fa-wifi',
                    true
                );
            }
        }
        
        state.participantsData[existingIndex] = participantData;
        console.log('既存参加者データを更新:', participantData.participant_id);
    } else {
        // 新規参加者
        if (!isOwnUpdate) {
            state.participantsData.push(participantData);
            
            ui.showNotification(
                `${participantData.participant_name.substring(0, 30)}が参加しました`,
                'success',
                'fas fa-user-plus',
                true
            );
        } else {
            const myIndex = state.participantsData.findIndex(
                p => p.participant_id === state.participantId
            );
            if (myIndex !== -1) {
                state.participantsData[myIndex] = participantData;
            } else {
                state.participantsData.push(participantData);
            }
        }
    }
    
    // ★重要：previousParticipantsStateも更新（次回の比較のため）
    if (!state.previousParticipantsState.has(participantData.participant_id)) {
        state.previousParticipantsState.set(participantData.participant_id, {
            name: participantData.participant_name || `参加者${participantData.participant_id.substring(0, 4)}`,
            status: participantData.status,
            is_sharing: participantData.status === 'sharing',
            is_online: participantData.is_online,
            hasValidLocation: participantData.latitude !== null && participantData.longitude !== null
        });
    } else {
        // 既存の状態を更新
        state.previousParticipantsState.set(participantData.participant_id, {
            name: participantData.participant_name || `参加者${participantData.participant_id.substring(0, 4)}`,
            status: participantData.status,
            is_sharing: participantData.status === 'sharing',
            is_online: participantData.is_online,
            hasValidLocation: participantData.latitude !== null && participantData.longitude !== null
        });
    }
    
    // ★ 追加：滞在時間更新時のマーカー即座更新
    if (participantData.stay_minutes !== undefined) {
        // マーカーアイコンを更新（滞在時間バッジ付き）
        if (mapManager.markers[participantData.participant_id]) {
            const marker = mapManager.markers[participantData.participant_id];
            const color = mapManager.getParticipantColor(participantData.participant_id);
            const name = (participantData.participant_name || `参加者${participantData.participant_id.substring(0, 4)}`).substring(0, 30);
            
            // アイコンを更新
            marker.setIcon(mapManager.createCustomMarker(
                name,
                color,
                participantData.is_background || false,
                participantData.stay_minutes,  // 滞在時間
                false,  // isInCluster
                1,      // clusterSize
                0,      // clusterIndex
                !participantData.is_online,  // isOffline
                0,      // movementSpeed
                false   // speedReliable
            ));
            
            // ポップアップが開いている場合は内容も更新
            const popup = marker.getPopup();
            if (popup && popup.isOpen()) {
                const location = {
                    ...participantData,
                    participant_id: participantData.participant_id,
                    participant_name: participantData.participant_name,
                    latitude: participantData.latitude,
                    longitude: participantData.longitude,
                    accuracy: participantData.accuracy,
                    status: participantData.status,
                    is_online: participantData.is_online,
                    is_background: participantData.is_background,
                    stay_minutes: participantData.stay_minutes,
                    last_updated: participantData.last_updated
                };
                
                const newPopupContent = mapManager.createPopupContent(
                    location,
                    name,
                    color,
                    participantData.stay_minutes,
                    participantData.is_background || false,
                    false,  // isInCluster
                    1,      // clusterSize
                    0,      // movementSpeed
                    false   // speedReliable
                );
                
                popup.setContent(newPopupContent);
                console.log(`ポップアップ更新完了: ${participantData.stay_minutes}分`);
            }
        }
    }
    
    // マーカーと参加者リストを更新
    mapManager.updateSingleMarkerOnly(participantData);
    participantManager.updateSingleParticipant(participantData);
    
    // チャット参加者リストも更新（必要な場合）
    if (window.chatManager && chatManager.chatModal.style.display !== 'none') {
        chatManager.updateSingleParticipantStatus(participantData);
    }
    
    // 自分の位置更新後のフォーカス処理
    if (isOwnUpdate && state.followingParticipantId === state.participantId) {
        const clusterInfo = mapManager.getCurrentClusterInfo(participantData.participant_id);
        if (clusterInfo) {
            const sortedParticipants = clusterInfo.participants.sort((a, b) => 
                a.participant_id.localeCompare(b.participant_id)
            );
            const participantIndex = sortedParticipants.findIndex(p => 
                p.participant_id === participantData.participant_id
            );
            
            if (participantIndex !== -1) {
                const angle = (2 * Math.PI * participantIndex) / sortedParticipants.length;
                const radius = CONFIG.CLUSTER_OFFSET_RADIUS;
                
                const clusterLat = clusterInfo.clusterCenter.lat + (radius * 0.00001) * Math.cos(angle);
                const clusterLng = clusterInfo.clusterCenter.lng + (radius * 0.00001) * Math.sin(angle);
                
                mapManager.focusOnPosition(clusterLat, clusterLng);
            }
        } else {
            mapManager.focusOnPosition(participantData.latitude, participantData.longitude);
        }
    }
}
// MessageHandler クラスに追加
detectSingleParticipantStateChange(oldData, newData) {
    if (!oldData || !newData) return;
    
    // 状態変化の検出
    if (!oldData.is_online && newData.is_online) {
        ui.showNotification(
            `${newData.participant_name.substring(0, 30)}が復帰しました`,
            'success',
            'fas fa-wifi',
            true
        );
    } else if (oldData.is_online && !newData.is_online) {
        ui.showNotification(
            `${newData.participant_name.substring(0, 30)}がオフラインになりました`,
            'secondary',
            'fas fa-wifi-slash',
            true
        );
    }
    
    if (!oldData.status === 'sharing' && newData.status === 'sharing') {
        ui.showNotification(
            `${newData.participant_name.substring(0, 30)}が位置情報を共有しました`,
            'info',
            'fas fa-map-marker-alt',
            true
        );
    } else if (oldData.status === 'sharing' && newData.status !== 'sharing') {
        ui.showNotification(
            `${newData.participant_name.substring(0, 30)}が共有を停止しました`,
            'warning',
            'fas fa-pause',
            true
        );
    }
}


    // === ★ ：重複削除応答処理 ===
handleDuplicateCleanupResponse(data) {
    if (data.success) {
        
        // if (data.removed_count > 0) {
        //     ui.showNotification(
        //         `${data.removed_count}人の重複参加者をセッションから削除しました`,
        //         'success',
        //         'fas fa-user-minus'
        //     );
        // }
        
        // 最新の参加者リストを要求
        this.requestLatestParticipantsList();
    } else {
        console.warn('サーバー側重複削除に失敗:', data.error || '不明なエラー');
        
        ui.showNotification(
            '重複参加者の削除処理でエラーが発生しました',
            'warning',
            'fas fa-exclamation-triangle'
        );
    }
}
// === ★ ：最新参加者リスト要求 ===
requestLatestParticipantsList() {
    if (!wsManager.websocket || wsManager.websocket.readyState !== WebSocket.OPEN) return;
    
    const requestData = {
        type: 'request_participants_update',
        participant_id: state.participantId,
        timestamp: new Date().toISOString(),
        reason: 'duplicate_cleanup'
    };
    
    wsManager.send(requestData);
}
    // === ：名前更新応答の処理 ===
    handleNameUpdateResponse(data) {
        if (data.success) {
            
            if (ui.elements.participantName) {
                ui.elements.participantName.classList.remove('is-invalid');
                ui.elements.participantName.classList.add('is-valid');
                
                setTimeout(() => {
                    if (ui.elements.participantName) {
                        ui.elements.participantName.classList.remove('is-valid');
                    }
                }, 2000);
            }
            
            // 成功通知
            if (data.show_notification) {
                ui.showNotification(
                    `名前を「${data.participant_name.substring(0, 20)}」に更新しました`, 
                    'success', 
                    'fas fa-user-check'
                );
            }
        } else {
            console.warn(`名前更新失敗: ${data.error || '不明なエラー'}`);
            
            if (ui.elements.participantName) {
                ui.elements.participantName.classList.add('is-invalid');
                eventHandlerManager.showNameDuplicateWarning(
                    ui.elements.participantName, 
                    data.attempted_name || '名前'
                );
            }
            
            // エラー通知
            ui.showNotification(
                data.error || '名前の更新に失敗しました', 
                'error', 
                'fas fa-user-times'
            );
            
            // 元の名前に戻す
            if (data.current_name && ui.elements.participantName) {
                ui.elements.participantName.value = data.current_name;
            }
        }
    }

    
    handleLocationUpdate(data) {
    if (data.locations) {
        
        // ★ 修正：重複処理を先に実行してから状態変化を検出
        const beforeCount = data.locations.length;
        
        // 1. 重複参加者を処理（participantManagerを通じて）
        const processedLocations = participantManager.processLocationsForDuplicates(data.locations);
        
        // 2. 処理後のデータで状態変化を検出
        this.detectStateChanges(processedLocations);
        
        // 3. マーカーと参加者リストを更新
        mapManager.updateMarkers(processedLocations);
        participantManager.updateListAfterProcessing(processedLocations);
        
        // 処理後の参加者数をログ出力
        const afterCount = processedLocations.length;
        if (beforeCount !== afterCount) {
        }
        // チャット参加者リストも更新
        if (window.chatManager && chatManager.chatModal.style.display !== 'none') {
            chatManager.handleParticipantStatusUpdate(data);
        }

    }
}
    
    handleBackgroundStatusChange(data) {
    if (data.locations) {
        
        // ★ 修正：重複処理を先に実行してから状態変化を検出
        const beforeCount = data.locations.length;
        
        // 1. 重複参加者を処理（participantManagerを通じて）
        const processedLocations = participantManager.processLocationsForDuplicates(data.locations);
        
        // 2. 処理後のデータで状態変化を検出
        this.detectStateChanges(processedLocations);
        
        // 3. マーカーと参加者リストを更新
        mapManager.updateMarkers(processedLocations);
        participantManager.updateListAfterProcessing(processedLocations);
        
        const afterCount = processedLocations.length;
        if (beforeCount !== afterCount) {
        }
        // チャット参加者リストも更新
        if (window.chatManager && chatManager.chatModal.style.display !== 'none') {
            chatManager.handleParticipantStatusUpdate(data);
        }
    }
}
    
    handleNotification(data) {
        if (data.exclude_self && data.participant_id === state.participantId) return;
        ui.showNotification(data.message, data.notification_type, data.icon);
    }
    
    handleError(data) {
        if (data.message.includes('期限切れ')) {
            sessionManager.handleExpired();
        }
    }
    
    handlePong(data) {
        if (ui.elements.lastCommunication) {
            ui.elements.lastCommunication.textContent = new Date().toLocaleTimeString() + ' (pong)';
        }
    }
    
    handleParticipantConfirmed(data) {
        if (data.participant_id && data.participant_id !== state.participantId) {
            state.participantId = data.participant_id;
            
            if (data.is_existing && data.participant_name) {
                if (ui.elements.participantName) {
                    ui.elements.participantName.value = data.participant_name;
                }
                ui.showNotification('セッションに復帰しました', 'success', 'fas fa-user-check');
            } else {
                ui.showNotification('セッションに参加しました', 'success', 'fas fa-user-plus');
            }
        }
    }
    
    detectStateChanges(newLocations) {
        // ★ 修正：自分が退出中の場合は状態変化検出をスキップ
        if (state.isLeaving || state.sessionExpired) {
            console.log('退出中のため状態変化検出をスキップ');
            return;
        }
        
        const currentState = new Map();
    
    newLocations.forEach(location => {
        const hasValidLocation = location.latitude !== null && 
                               location.longitude !== null && 
                               location.latitude !== 999.0 && 
                               location.longitude !== 999.0 &&
                               !isNaN(location.latitude) && 
                               !isNaN(location.longitude);
        
        const isSharing = location.status === 'sharing' && hasValidLocation;
        
        currentState.set(location.participant_id, {
            name: location.participant_name || `参加者${location.participant_id.substring(0, 4)}`,
            status: location.status,
            is_sharing: isSharing,
            is_online: location.is_online,
            hasValidLocation: hasValidLocation
        });
    });
    
    // ★ 修正：新規参加者の検出時に重複チェック済みのデータを使用
    currentState.forEach((current, participant_id) => {
        // 自分自身の状態変化は通知しない
        if (participant_id === state.participantId) return;
        
        const previous = state.previousParticipantsState.get(participant_id);
        
        if (!previous) {
            // ★ 修正：新規参加者通知（重複処理後なので安全）
            ui.showNotification(
                `${current.name.substring(0, 30)}が参加しました`,
                'success',
                'fas fa-user-plus',
                true
            );
        } else {
            this.checkStatusChanges(previous, current);
            this.checkOnlineOfflineTransition(previous, current, participant_id);
        }
    });
    
    // 退出者の検出（自分以外のみ通知）
    state.previousParticipantsState.forEach((previous, participant_id) => {
        // 自分自身の退出は通知しない
        if (participant_id === state.participantId) return;
        
        if (!currentState.has(participant_id)) {
            ui.showNotification(
                `${previous.name.substring(0, 30)}が退出しました`,
                'secondary',
                'fas fa-user-minus',
                true
            );
        }
    });
    
    state.previousParticipantsState = new Map(currentState);
}
    // === ★ ：オンライン/オフライン変化時のマーカー即座更新 ===
checkOnlineOfflineTransition(previous, current, participant_id) {
    // オンライン → オフライン移行
    if (previous.is_online && !current.is_online && current.hasValidLocation) {
        
        // 該当参加者のデータを取得
        const participantData = state.participantsData.find(p => p.participant_id === participant_id);
        if (participantData) {
            // オフライン状態でマーカーを即座更新
            const offlineLocation = {
                ...participantData,
                isOffline: true,
                is_online: false,
                has_shared_before: true // オフライン時は共有履歴ありとして扱う
            };
            
            mapManager.updateSingleMarker(offlineLocation);
        }
    }
    
    // オフライン → オンライン移行
    if (!previous.is_online && current.is_online && current.hasValidLocation) {
        
        // 該当参加者のデータを取得
        const participantData = state.participantsData.find(p => p.participant_id === participant_id);
        if (participantData) {
            // オンライン状態でマーカーを即座更新
            const onlineLocation = {
                ...participantData,
                isOffline: false,
                is_online: true
            };
            
            mapManager.updateSingleMarker(onlineLocation);
        }
    }
}
    // === MessageHandler クラス - checkStatusChanges メソッドの修正 ===
checkStatusChanges(previous, current) {
    if (!previous.is_sharing && current.is_sharing) {
        ui.showNotification(
            `${current.name.substring(0, 30)}が位置情報を共有しました`,
            'info',
            'fas fa-map-marker-alt',
            true
        );
    } else if (previous.is_sharing && !current.is_sharing) {
        ui.showNotification(
            `${current.name.substring(0, 30)}が共有を停止しました`,
            'warning',
            'fas fa-pause',
            true
        );
    }
    
    if (!previous.is_online && current.is_online) {
        ui.showNotification(
            `${current.name.substring(0, 30)}が復帰しました`,
            'success',
            'fas fa-wifi',
            true
        );
        
        // ★ オンライン復帰時のマーカー即座更新
        this.updateMarkerToOnlineState(current);
    } else if (previous.is_online && !current.is_online) {
        ui.showNotification(
            `${current.name.substring(0, 30)}がオフラインになりました`,
            'secondary',
            'fas fa-wifi-slash',
            true
        );
        
        // ★ オフライン移行時のマーカー即座更新
        this.updateMarkerToOfflineState(current);
    }
}

// === ★ ：オフライン状態への即座マーカー更新 ===
updateMarkerToOfflineState(participantData) {
    // 該当参加者のデータを取得
    const participant = state.participantsData.find(p => p.participant_id === participantData.participant_id);
    if (!participant) return;
    
    const hasValidCoords = participant.latitude !== null && 
                          participant.longitude !== null && 
                          participant.latitude !== 999.0 && 
                          participant.longitude !== 999.0 &&
                          !isNaN(participant.latitude) && 
                          !isNaN(participant.longitude);
    
    if (hasValidCoords) {
        const offlineLocation = {
            ...participant,
            isOffline: true,
            is_online: false,
            has_shared_before: true,
            status: participant.status || 'stopped',
            last_seen_at: participant.last_updated || new Date().toISOString()
        };
        
        
        // ★ オフライン移行時にアニメーションを即座停止
        mapManager.stopRegularAnimation(participantData.participant_id);
        
        // ★ 精度円を削除
        if (mapManager.accuracyCircles[participantData.participant_id]) {
            mapManager.map.removeLayer(mapManager.accuracyCircles[participantData.participant_id]);
            delete mapManager.accuracyCircles[participantData.participant_id];
        }
        
        // ★ アニメーション円を削除
        if (mapManager.animationCircles[participantData.participant_id]) {
            mapManager.map.removeLayer(mapManager.animationCircles[participantData.participant_id]);
            delete mapManager.animationCircles[participantData.participant_id];
        }
        
        mapManager.updateSingleMarker(offlineLocation);
        
        // 参加者リストも即座更新
        participantManager.updateDisplay();
    } else {
        // 位置情報がない場合はマーカーを削除
        mapManager.removeMarker(participantData.participant_id);
    }
}

// === ★ ：オンライン状態への即座マーカー更新 ===
updateMarkerToOnlineState(participantData) {
    // 該当参加者のデータを取得
    const participant = state.participantsData.find(p => p.participant_id === participantData.participant_id);
    if (!participant) return;
    
    // 有効な位置情報を持つ場合のみオンラインマーカーを表示
    const hasValidCoords = participant.latitude !== null && 
                          participant.longitude !== null && 
                          participant.latitude !== 999.0 && 
                          participant.longitude !== 999.0 &&
                          !isNaN(participant.latitude) && 
                          !isNaN(participant.longitude);
    
    if (hasValidCoords && participant.status === 'sharing') {
        const onlineLocation = {
            ...participant,
            isOffline: false,
            is_online: true
        };
        
        mapManager.updateSingleMarker(onlineLocation);
        
        // 参加者リストも即座更新
        participantManager.updateDisplay();
    }
}
}

// === 位置情報管理クラス ===
class LocationManager {
constructor() {
    this.watchId = null;
    this.locationInterval = null;
    this.backgroundLocationUpdate = null;
    this.forcedUpdateTimeout = null;
    
    // ★ 滞在時間追跡
    this.stayTracker = {
        basePosition: null,        // 滞在開始時の基準位置
        stayStartTime: null,       // 滞在開始時刻
    };
    
    // ★ 追加：更新設定
    this.UPDATE_CONFIG = {
        MOVEMENT_THRESHOLD: 3,      // 3m以上で送信
        MIN_INTERVAL: 1000,         // 最小1秒間隔
        MAX_INTERVAL: 10000,        // 最大10秒間隔（移動時）
    };
    
    // ★ 追加：最後の有意な移動時刻
    this.lastSignificantMovement = null;
}
    
    
startSharing() {
    // ★ 停止処理中は開始を防ぐ
    if (this.isStopping) {
        ui.showNotification(
            '処理中です。しばらくお待ちください',
            'warning',
            'fas fa-hourglass-half'
        );
        return;
    }
    
    if (!navigator.geolocation) {
        ui.updateStatus('location', 'error', 'このブラウザでは位置情報がサポートされていません');
        return;
    }

    state.isSharing = true;
    state.lastSentPosition = null;
    state.lastSentTime = 0;

    if (this.forcedUpdateTimeout) {
        clearTimeout(this.forcedUpdateTimeout);
        this.forcedUpdateTimeout = null;
    }

    ui.updateStatus('location', 'waiting', '位置情報を取得中...');
    
    const options = {
        enableHighAccuracy: true,
        timeout: CONFIG.LOCATION_TIMEOUT,
        maximumAge: 2000
    };
    
    // getCurrentPositionのエラーハンドラーを直接バインド
    navigator.geolocation.getCurrentPosition(
        (position) => {
            this.handleInitialPosition(position);
        },
        (error) => {

            // エラーコードを直接チェック
            if (error.code === 1) { // PERMISSION_DENIED
                
                // 状態を更新
                ui.updateStatus('location', 'error', '位置情報の利用が拒否されました');
                state.isSharing = false;
                ui.updateSharingButton();
                
                // 直接ヒントモーダルを表示
                this.showLocationPermissionHint();
                
                // 通知も表示
                ui.showNotification(
                    '位置情報が拒否されました。設定方法を確認してください',
                    'warning',
                    'fas fa-map-marker-alt'
                );
            } else {
                // その他のエラー処理
                this.handleLocationError(error);
            }
        },
        options
    );
    
    ui.updateSharingButton();
}
    
handleInitialPosition(position) {
    
    state.lastKnownPosition = position;
    
    // 滞在追跡の基準位置のみ設定（時間計算は不要）
    this.stayTracker.basePosition = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
    };
     
    this.sendLocationUpdate(position);
    state.lastSentPosition = position;
    state.lastSentTime = Date.now();
    
    this.updateLocationStatus();
    this.startTracking();
    this.startBackgroundLocationUpdate();
    
    // 自分の位置にフォーカス
    setTimeout(() => {
        if (mapManager.isInitialized() && position) {
            mapManager.focusOnPosition(position.coords.latitude, position.coords.longitude);
            state.followingParticipantId = state.participantId;
        }
    }, 500);
    
    state.save();
}
    
startTracking() {
    if (this.watchId) {
        navigator.geolocation.clearWatch(this.watchId);
    }
    
    // 最後の有意な移動時刻を初期化
    this.lastSignificantMovement = Date.now();
    
    // watchPositionで位置の変化を監視（既存のまま）
    this.watchId = navigator.geolocation.watchPosition(
        (position) => this.handlePositionUpdate(position),
        (error) => {
            console.warn('位置情報監視エラー:', error);
            if (error.code === 1) {
                ui.updateStatus('location', 'error', '位置情報の利用が拒否されました');
                state.isSharing = false;
                ui.updateSharingButton();
                this.showLocationPermissionHint();
            }
        },
        {
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 500
        }
    );
}

    
handlePositionUpdate(position) {
    console.log('=== 位置情報更新 ===');
    
    const currentTime = Date.now();
    const timeSinceLastUpdate = currentTime - state.lastSentTime;
    
    // 内部状態を更新
    state.lastKnownPosition = position;
    this.updateLocationStatus();
    this.updateStayTime(position);
    state.save();
    
    // 移動距離を計算
    let distance = 0;
    let isMoving = false;
    
    if (state.lastSentPosition) {
        distance = this.calculateDistance(
            state.lastSentPosition.coords.latitude,
            state.lastSentPosition.coords.longitude,
            position.coords.latitude,
            position.coords.longitude
        );
        
        // 3m以上の移動があれば移動中と判定
        if (distance >= this.UPDATE_CONFIG.MOVEMENT_THRESHOLD) {
            isMoving = true;
            this.lastSignificantMovement = currentTime;
            console.log(`有意な移動検出: ${distance.toFixed(2)}m`);
        }
    } else {
        // 初回は必ず送信
        isMoving = true;
        this.lastSignificantMovement = currentTime;
    }
    
    // 静止時間を計算（最後の有意な移動からの経過時間）
    const timeSinceLastMovement = this.lastSignificantMovement ? 
        currentTime - this.lastSignificantMovement : 0;
    const isStationary = timeSinceLastMovement > 60000; // 1分以上移動なしで完全静止と判定
    
    // 送信判定
    let shouldSend = false;
    let reason = '';
    
    // 最小間隔チェック
    if (timeSinceLastUpdate < this.UPDATE_CONFIG.MIN_INTERVAL) {
        shouldSend = false;
        reason = '最小間隔未満';
    }
    // 移動検出時は即座に送信
    else if (isMoving) {
        shouldSend = true;
        reason = `移動検出 (${distance.toFixed(1)}m)`;
    }
    // 通常の最大間隔チェック
    else if (timeSinceLastUpdate >= this.UPDATE_CONFIG.MAX_INTERVAL) {
        shouldSend = true;
        reason = '最大間隔到達';
    }
    // 初回送信
    else if (!state.lastSentPosition) {
        shouldSend = true;
        reason = '初回送信';
    }
    
    if (shouldSend) {
        console.log(`位置情報送信: ${reason}`);
        
        // participant_idが設定されているか確認
        if (!state.participantId) {
            console.warn('participant_id が未設定のため送信をスキップ');
            return;
        }
        
        this.sendLocationUpdate(position);
        state.lastSentPosition = position;
        state.lastSentTime = currentTime;
        
        // 強制更新タイマーをリセット
        if (this.forcedUpdateTimeout) {
            clearTimeout(this.forcedUpdateTimeout);
            this.forcedUpdateTimeout = null;
        }
        
        // 方向指示の更新（移動中の場合のみ）
        if (isMoving && distance >= this.UPDATE_CONFIG.MOVEMENT_THRESHOLD) {
            // 既存の方向指示更新ロジックを維持
            console.log('方向指示を更新');
        } else if (!isMoving && mapManager.directionIndicators && mapManager.directionIndicators[state.participantId]) {
            // 静止時は方向指示を削除
            if (mapManager.map.hasLayer(mapManager.directionIndicators[state.participantId])) {
                mapManager.map.removeLayer(mapManager.directionIndicators[state.participantId]);
            }
            delete mapManager.directionIndicators[state.participantId];
        }
    } else {
        console.log(`送信スキップ: ${reason} (経過: ${timeSinceLastUpdate}ms, 距離: ${distance.toFixed(1)}m)`);
    }
}

// locationSharing.js の updateStayTime メソッドを修正
updateStayTime(position) {
    
    if (!this.stayTracker.basePosition) {
        // 基準点がない場合は初期化
        this.stayTracker.basePosition = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };
        return;
    }
    
    // 基準点からの距離を計算
    const distance = this.calculateDistance(
        this.stayTracker.basePosition.lat,
        this.stayTracker.basePosition.lng,
        position.coords.latitude,
        position.coords.longitude
    );
    
    // 30m以上離れたら新しい基準点に更新（★ 閾値を30mに変更）
    if (distance >= 30) {
        // 新しい基準点を設定
        this.stayTracker.basePosition = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };
        // ★ 重要：サーバーに滞在時間リセットを通知
        this.sendStayResetNotification();
    } else {
    }
}
    
    // ★ ：滞在地点リセット通知
sendStayResetNotification() {
    
    if (wsManager.websocket && wsManager.websocket.readyState === WebSocket.OPEN) {
        const resetData = {
            type: 'stay_reset',
            participant_id: state.participantId,
            timestamp: new Date().toISOString()
        };
        
        
        const sent = wsManager.send(resetData);
        
        if (sent) {
            console.log('滞在時間リセット通知送信成功');
        } else {
            console.log('滞在時間リセット通知送信失敗');
        }
    } else {
        console.log('WebSocket未接続のため滞在時間リセット通知をスキップ');
    }
}
    
    // ★ ：現在の滞在時間を取得（分単位）
getCurrentStayMinutes() {
    // クライアント側では計算しない
    return 0;
}

checkIfInCluster(lat, lng) {
    // 自分以外の参加者で位置共有中の人を取得
    const nearbyParticipants = state.participantsData.filter(p => {
        if (p.participant_id === state.participantId) return false;
        if (!p.is_online || p.status !== 'sharing') return false;
        if (p.latitude === null || p.longitude === null) return false;
        
        // 距離を計算
        const distance = this.calculateDistance(lat, lng, p.latitude, p.longitude);
        return distance <= CONFIG.CLUSTERING_DISTANCE;
    });
    
    // 1人以上近くにいればクラスター内と判定
    return nearbyParticipants.length > 0;
}

shouldSendUpdate(position) {
    const now = Date.now();
    
    // ★ 修正：最小間隔を1秒に短縮
    if (now - state.lastSentTime < CONFIG.MIN_TIME_BETWEEN_UPDATES) {
        return false;
    }
    
    if (!state.lastSentPosition) {
        return true;
    }
    
    const distance = this.calculateDistance(
        state.lastSentPosition.coords.latitude,
        state.lastSentPosition.coords.longitude,
        position.coords.latitude,
        position.coords.longitude
    );
    
    // ★ 重要：1m未満の移動は送信しない
    if (distance < CONFIG.MOVEMENT_THRESHOLD) {
        return false;
    }
    
    // 移動閾値を超えた場合
    if (distance >= CONFIG.MOVEMENT_THRESHOLD) {
        return true;
    }
    
    return false;
}
    

    
sendLocationUpdate(position) {
    // participant_idの確認
    if (!state.participantId) {
        console.error('sendLocationUpdate: participant_id が未設定');
        return;
    }
    
    // 現在のクラスタ情報を取得
    const currentClusterInfo = mapManager.getCurrentClusterInfo(state.participantId);
    
    const locationData = {
        type: 'single_participant_update',
        participant_id: state.participantId,
        participant_name: state.getParticipantName(),
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: this.validateAccuracy(position.coords.accuracy),
        timestamp: new Date().toISOString(),
        is_background: state.isInBackground,
        // クラスタ情報を含める
        in_cluster: currentClusterInfo ? true : false,
        cluster_id: currentClusterInfo ? currentClusterInfo.clusterId : null
    };
    
    // 送信前の最終チェック
    if (wsManager.websocket && wsManager.websocket.readyState === WebSocket.OPEN) {
        wsManager.send(locationData);
    } else {
        console.warn('WebSocket未接続のため位置情報送信をスキップ');
    }
}

    validateAccuracy(accuracy) {
        if (!accuracy || accuracy <= 0 || accuracy > 1000) {
            return null;
        }
        return Math.round(accuracy);
    }
    
stopSharing() {
    
    // ★ 修正：停止処理中フラグを最初に設定
    if (this.isStopping) {
        return;
    }
    this.isStopping = true;
    
    // ★ 修正：最初に共有フラグを即座にfalseにする
    state.isSharing = false;
    
    // 位置情報の監視を即座に停止
    if (this.watchId) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
    }
    
    if (this.locationInterval) {
        clearInterval(this.locationInterval);
        this.locationInterval = null;
    }
    
    // バックグラウンド更新を停止
    this.stopBackgroundLocationUpdate();
    
    // 強制更新タイマーを停止
    if (this.forcedUpdateTimeout) {
        clearTimeout(this.forcedUpdateTimeout);
        this.forcedUpdateTimeout = null;
    }
    
    // 滞在追跡をリセット
    this.stayTracker = {
        basePosition: null,
        stayStartTime: null,
    };
    
    state.lastSentPosition = null;
    
    // ★ 方向指示を即座に削除
    if (mapManager.directionIndicators && mapManager.directionIndicators[state.participantId]) {
        if (mapManager.map.hasLayer(mapManager.directionIndicators[state.participantId])) {
            mapManager.map.removeLayer(mapManager.directionIndicators[state.participantId]);
        }
        delete mapManager.directionIndicators[state.participantId];
    }
    
    // ★ 移動アニメーションも停止
    if (mapManager.movementTrackers && mapManager.movementTrackers[state.participantId]) {
        if (mapManager.movementTrackers[state.participantId].animationId) {
            cancelAnimationFrame(mapManager.movementTrackers[state.participantId].animationId);
        }
        delete mapManager.movementTrackers[state.participantId];
    }
    
    // ★ 移動停止タイマーもクリア
    if (mapManager.movementStopTimers && mapManager.movementStopTimers[state.participantId]) {
        delete mapManager.movementStopTimers[state.participantId];
    }
    
    // 自分のマーカーを削除
    mapManager.removeOwnMarker();
    
    // 参加者データを更新
    state.participantsData = state.participantsData.map(p => {
        if (p.participant_id === state.participantId) {
            return {
                ...p,
                latitude: null,
                longitude: null,
                accuracy: null,
                status: 'waiting',
                is_online: true,
                has_shared_before: false
            };
        }
        return p;
    });
    
    // ★ 修正：共有停止通知に方向指示削除を明示的に追加
    const stopSharingData = {
        type: 'stop_sharing',
        participant_id: state.participantId,
        participant_name: state.getParticipantName(),
        is_background: state.isInBackground,
        clear_location: true,
        remove_marker: true,
        remove_direction_indicator: true,  // ★ 追加：方向指示削除フラグ
        timestamp: new Date().toISOString()
    };
    
    const sent = wsManager.send(stopSharingData);
    
    // UIを更新
    ui.updateSharingButton();
    this.updateLocationStatus();
    state.save();
    
    // ★ 修正：停止処理完了後、3秒間は再開始を防ぐ
    setTimeout(() => {
        this.isStopping = false;
    }, 3000);
}
    
handleLocationError(error) {
    
    let message = '';
    switch(error.code) {
        case error.PERMISSION_DENIED:
            message = '位置情報の利用が拒否されました';
            ui.updateStatus('location', 'error', message);
            state.isSharing = false;
            ui.updateSharingButton();
            
            // 位置情報許可のヒントを表示
            this.showLocationPermissionHint();
            break;
        case error.POSITION_UNAVAILABLE:
            message = '位置情報が取得できませんでした';
            ui.updateStatus('location', 'error', message);
            
            // リトライ案内を表示
            ui.showNotification(
                '位置情報が取得できません。設定を確認してください',
                'warning',
                'fas fa-exclamation-triangle'
            );
            break;
        case error.TIMEOUT:
            message = '位置情報の取得がタイムアウトしました';
            ui.updateStatus('location', 'waiting', message + ' - 再試行中...');
            
            // タイムアウト時は自動リトライ
            setTimeout(() => {
                if (state.isSharing && !state.sessionExpired) {
                    this.startSharing();
                }
            }, 3000);
            break;
        default:
            message = '位置情報の取得中にエラーが発生しました';
            ui.updateStatus('location', 'error', message);
            break;
    }
    
    console.warn('位置情報エラー:', message, error);
}
    showLocationPermissionHint() {
    
    // 既存のモーダルがあれば削除
    const existingModal = document.getElementById('location-hint-modal');
    if (existingModal) {
        const bsModal = bootstrap.Modal.getInstance(existingModal);
        if (bsModal) {
            bsModal.dispose();
        }
        existingModal.remove();
    }
    
    // ブラウザとOSを検出
    const userAgent = navigator.userAgent.toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(userAgent);
    const isAndroid = /android/.test(userAgent);
    const isChrome = /chrome/.test(userAgent) && !/edg/.test(userAgent);
    const isFirefox = /firefox/.test(userAgent);
    const isSafari = /safari/.test(userAgent) && !/chrome/.test(userAgent);
    const isEdge = /edg/.test(userAgent);
    
    let instructions = '';
    
    // デバイス・ブラウザ別の設定方法を作成
    if (isIOS) {
        if (isSafari) {
            instructions = `
                <h6><i class="fas fa-mobile-alt"></i> iPhone/iPadで位置情報を有効にする方法</h6>
                <ol class="text-start small">
                    <li><strong>設定アプリ</strong>を開く</li>
                    <li><strong>プライバシーとセキュリティ</strong>をタップ</li>
                    <li><strong>位置情報サービス</strong>をタップ</li>
                    <li>位置情報サービスを<strong>オン</strong>にする</li>
                    <li>下にスクロールして<strong>Safari</strong>を探す</li>
                    <li><strong>このAppの使用中のみ許可</strong>を選択</li>
                    <li>このページを再読み込みして、もう一度「共有開始」をタップ</li>
                </ol>
                <div class="alert alert-info mt-2">
                    <small><i class="fas fa-info-circle"></i> Safari設定で「位置情報へのアクセス」も確認してください</small>
                </div>
            `;
        } else {
            instructions = `
                <h6><i class="fas fa-mobile-alt"></i> iPhone/iPadで位置情報を有効にする方法</h6>
                <ol class="text-start small">
                    <li><strong>設定アプリ</strong>を開く</li>
                    <li><strong>プライバシーとセキュリティ</strong>をタップ</li>
                    <li><strong>位置情報サービス</strong>をタップ</li>
                    <li>お使いのブラウザ（Chrome/Firefox等）を探す</li>
                    <li><strong>このAppの使用中のみ許可</strong>を選択</li>
                    <li>このページを再読み込みして、もう一度「共有開始」をタップ</li>
                </ol>
            `;
        }
    } else if (isAndroid) {
        instructions = `
            <h6><i class="fas fa-mobile-alt"></i> Androidで位置情報を有効にする方法</h6>
            <ol class="text-start small">
                <li>ブラウザのアドレスバー左側の<strong>鍵アイコン</strong>または<strong>ⓘアイコン</strong>をタップ</li>
                <li><strong>サイトの設定</strong>または<strong>権限</strong>をタップ</li>
                <li><strong>位置情報</strong>を探してタップ</li>
                <li><strong>許可</strong>を選択</li>
                <li>ページを再読み込みして、もう一度「共有開始」をタップ</li>
            </ol>
            <div class="alert alert-secondary mt-2">
                <small><strong>または端末の設定から：</strong></small>
                <ol class="mb-0 small">
                    <li>設定 → アプリ → ブラウザアプリを選択</li>
                    <li>権限 → 位置情報 → 許可</li>
                </ol>
            </div>
        `;
    } else if (isChrome) {
        instructions = `
            <h6><i class="fab fa-chrome"></i> Google Chromeで位置情報を有効にする方法</h6>
            <ol class="text-start small">
                <li>アドレスバーの左側にある<strong>鍵アイコン</strong>をクリック</li>
                <li><strong>サイトの設定</strong>をクリック</li>
                <li><strong>位置情報</strong>の項目を<strong>許可</strong>に変更</li>
                <li>ページを再読み込み（F5キー）</li>
                <li>もう一度「共有開始」ボタンをクリック</li>
            </ol>
            <div class="alert alert-info mt-2">
                <small><i class="fas fa-lightbulb"></i> ヒント: chrome://settings/content/location でも設定できます</small>
            </div>
        `;
    } else if (isFirefox) {
        instructions = `
            <h6><i class="fab fa-firefox"></i> Firefoxで位置情報を有効にする方法</h6>
            <ol class="text-start small">
                <li>アドレスバーの左側にある<strong>鍵アイコン</strong>をクリック</li>
                <li><strong>安全でない接続</strong>または<strong>接続は安全です</strong>の横の<strong>></strong>をクリック</li>
                <li><strong>詳細を表示</strong>をクリック</li>
                <li><strong>サイト別設定</strong>タブを選択</li>
                <li><strong>位置情報の取得</strong>を<strong>許可</strong>に変更</li>
                <li>ページを再読み込み（F5キー）</li>
            </ol>
        `;
    } else if (isSafari) {
        instructions = `
            <h6><i class="fab fa-safari"></i> Safariで位置情報を有効にする方法</h6>
            <ol class="text-start small">
                <li>メニューバーの<strong>Safari</strong>をクリック</li>
                <li><strong>設定</strong>（または環境設定）を選択</li>
                <li><strong>Webサイト</strong>タブをクリック</li>
                <li>左側のリストから<strong>位置情報</strong>を選択</li>
                <li>このサイトを探して<strong>許可</strong>に変更</li>
                <li>ページを再読み込み（Command + R）</li>
            </ol>
        `;
    } else if (isEdge) {
        instructions = `
            <h6><i class="fab fa-edge"></i> Microsoft Edgeで位置情報を有効にする方法</h6>
            <ol class="text-start small">
                <li>アドレスバーの左側にある<strong>鍵アイコン</strong>をクリック</li>
                <li><strong>このサイトのアクセス許可</strong>をクリック</li>
                <li><strong>場所</strong>を<strong>許可</strong>に変更</li>
                <li>ページを再読み込み（F5キー）</li>
                <li>もう一度「共有開始」ボタンをクリック</li>
            </ol>
        `;
    } else {
        // デフォルトの汎用的な説明
        instructions = `
            <h6><i class="fas fa-map-marker-alt"></i> 位置情報を有効にする方法</h6>
            <ol class="text-start small">
                <li>ブラウザのアドレスバー付近にある<strong>位置情報アイコン</strong>を探す</li>
                <li>このサイトに対して位置情報を<strong>許可</strong>する</li>
                <li>ページを再読み込みする</li>
                <li>もう一度「共有開始」ボタンをクリック</li>
            </ol>
            <div class="alert alert-warning mt-2">
                <small><i class="fas fa-exclamation-triangle"></i> お使いのブラウザの設定メニューから位置情報の権限を確認してください</small>
            </div>
        `;
    }
    
    // モーダルを作成して表示
    const modalDiv = document.createElement('div');
    modalDiv.className = 'modal fade';
    modalDiv.id = 'location-hint-modal';
    modalDiv.setAttribute('tabindex', '-1');
    modalDiv.setAttribute('data-bs-backdrop', 'static');
    modalDiv.innerHTML = `
        <div class="modal-dialog modal-dialog-centered modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-warning">
                    <h5 class="modal-title">
                        <i class="fas fa-location-arrow"></i> 位置情報の設定方法
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-warning mb-3">
                        <i class="fas fa-exclamation-circle"></i> 
                        位置情報の共有には、ブラウザの位置情報許可が必要です
                    </div>
                    ${instructions}
                    <div class="mt-3 p-3 bg-light rounded">
                        <h6 class="text-muted mb-2"><i class="fas fa-shield-alt"></i> プライバシー保護について</h6>
                        <small class="text-muted">
                            • 位置情報は本セッション内でのみ共有されます<br>
                            • 位置情報の共有はいつでも停止できます
                        </small>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        閉じる
                    </button>
                    <button type="button" class="btn btn-primary" onclick="location.reload()">
                        <i class="fas fa-redo"></i> ページを再読み込み
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modalDiv);
    // Bootstrapモーダルとして初期化して表示
    try {
        const modal = new bootstrap.Modal(modalDiv);
        modal.show();
    } catch (error) {
        console.error('Failed to show modal:', error);
    }
    
    // 通知も表示
    ui.showNotification(
        '位置情報が拒否されました。設定方法を確認してください',
        'warning',
        'fas fa-map-marker-alt'
    );
}
    updateLocationStatus() {
        if (!ui.elements.locationStatus) return;
        
        if (!state.isSharing) {
            ui.updateStatus('location', 'waiting', '参加中（未共有）');
            return;
        }
        
        const hasValidLocation = state.lastKnownPosition && 
                               state.lastKnownPosition.coords &&
                               state.lastKnownPosition.coords.latitude !== null && 
                               state.lastKnownPosition.coords.longitude !== null && 
                               !isNaN(state.lastKnownPosition.coords.latitude) && 
                               !isNaN(state.lastKnownPosition.coords.longitude);
        
        if (!hasValidLocation) {
            ui.updateStatus('location', 'waiting', '状態確認中');
            return;
        }
        
        if (state.isInBackground) {
            ui.updateStatus('location', 'background', 'バックグラウンド');
        } else {
            ui.updateStatus('location', 'active', 'オンライン');
        }
    }
    
    startBackgroundLocationUpdate() {
        if (this.backgroundLocationUpdate) {
            clearInterval(this.backgroundLocationUpdate);
        }
        
        const updateInterval = wsManager.isMobileDevice() ? CONFIG.BACKGROUND_UPDATE_INTERVAL : 10000;
        
        this.backgroundLocationUpdate = setInterval(() => {
            if (state.isInBackground && state.isSharing && state.lastKnownPosition) {
                this.sendLocationUpdate(state.lastKnownPosition);
            }
        }, updateInterval);
    }
    
    stopBackgroundLocationUpdate() {
        if (this.backgroundLocationUpdate) {
            clearInterval(this.backgroundLocationUpdate);
            this.backgroundLocationUpdate = null;
        }
    }
        calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }
}

// === マップ管理クラス ===
class MapManager {
constructor() {
    this.map = null;
    this.markers = {};
    this.accuracyCircles = {};
    this.animationCircles = {};
    this.regularAnimationIntervals = {};
    this.markerUpdateQueue = new Map();
    this.mapInitialized = false;
    this.clusters = new Map();
    this.currentClusters = new Map();  // ★追加：現在のクラスタ状態を保持
    this.clusterConnections = {};
    this.pulseAnimations = {};
    this.openClusterPopups = new Map();
    this.movementTrackers = {};
    this.directionIndicators = {};
    this.previousPositions = {};
    this.lastUpdateTimes = {}; 
    this.originalPositions = {};  // ★追加：元の座標を保持
}
    
    init() {
        this.map = L.map('map').setView([35.6762, 139.6503], 13);
        
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(this.map);
        
        this.setupEventHandlers();
        this.mapInitialized = true;
    }
    // 密集グループを検出して処理
    detectAndHandleClusters(locations) {
    const clusters = new Map();
    const processed = new Set();

    locations.forEach((location, index) => {
        if (processed.has(location.participant_id)) return;

        const cluster = [location];
        processed.add(location.participant_id);

        // 他の参加者との距離をチェック（オンライン・オフライン問わず）
        locations.forEach((otherLocation, otherIndex) => {
            if (index === otherIndex || processed.has(otherLocation.participant_id)) return;

            const distance = this.calculateDistance(
                location.latitude, location.longitude,
                otherLocation.latitude, otherLocation.longitude
            );

            if (distance <= CONFIG.CLUSTERING_DISTANCE) {
                cluster.push(otherLocation);
                processed.add(otherLocation.participant_id);
            }
        });

        if (cluster.length > 1) {
            const centerLat = cluster.reduce((sum, loc) => sum + loc.latitude, 0) / cluster.length;
            const centerLng = cluster.reduce((sum, loc) => sum + loc.longitude, 0) / cluster.length;
            
            // ★ 修正：クラスタ内のオンライン・オフライン数をカウント
            const onlineCount = cluster.filter(p => p.is_online === true && p.status === 'sharing').length;
            const offlineCount = cluster.filter(p => p.is_online === false || p.status === 'stopped').length;
            
            clusters.set(`cluster_${index}`, {
                participants: cluster,
                centerLat,
                centerLng,
                isCluster: true,
                onlineCount,
                offlineCount
            });
        } else {
            clusters.set(location.participant_id, {
                participants: [location],
                centerLat: location.latitude,
                centerLng: location.longitude,
                isCluster: false
            });
        }
    });

    return clusters;
}
        calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }
    // === マップ管理クラス - setupEventHandlers メソッドに追加 ===
setupEventHandlers() {
    this.map.on('dragstart', () => {
        state.userInteracted = true;
        state.autoFitEnabled = false;
        
        // 個人追従とグループ追従の両方を解除
        if (state.followingParticipantId) {
            state.followingParticipantId = null;
        }
        
        if (state.followingGroup) {
            state.followingGroup = null;
            this.stopGroupFollowingTimer();
        }
    });

    this.map.on('zoomstart', () => {
        state.userInteracted = true;
        state.autoFitEnabled = false;
    });

    this.map.on('click', (e) => {
        if (!e.originalEvent.target.closest('.custom-marker') && 
            !e.originalEvent.target.closest('.leaflet-popup')) {
            
            // 個人追従とグループ追従の両方を解除
            if (state.followingParticipantId) {
                state.followingParticipantId = null;
            }
            
            if (state.followingGroup) {
                state.followingGroup = null;
                this.stopGroupFollowingTimer();
            }
        }
    });
}
    
    isInitialized() {
        return this.mapInitialized;
    }
    
    focusOnPosition(lat, lng, zoom = 15) {
        if (this.mapInitialized) {
            this.map.setView([lat, lng], Math.max(this.map.getZoom(), zoom));
        }
    }
    
    // === マップ管理クラス - updateMarkers メソッドの修正 ===
updateMarkers(locations) {
    if (!this.mapInitialized) return;
    
    const currentMarkerIds = new Set(Object.keys(this.markers));
    
    // オンライン参加者の判定
    const onlineLocations = locations.filter(loc => {
        const hasValidCoords = loc.latitude !== null && 
                              loc.longitude !== null && 
                              loc.latitude !== 999.0 && 
                              loc.longitude !== 999.0 &&
                              !isNaN(loc.latitude) && 
                              !isNaN(loc.longitude);
        
        return hasValidCoords && loc.is_online === true && loc.status === 'sharing';
    });

    // オフライン参加者の判定
    const offlineLocations = locations.filter(loc => {
        const hasValidCoords = loc.latitude !== null && 
                              loc.longitude !== null && 
                              loc.latitude !== 999.0 && 
                              loc.longitude !== 999.0 &&
                              !isNaN(loc.latitude) && 
                              !isNaN(loc.longitude);
        
        const isOffline = loc.is_online === false || loc.status === 'stopped';
        const hasSharedBefore = loc.has_shared_before === true;
        
        return hasValidCoords && isOffline && hasSharedBefore;
    });

    const allLocationsForClustering = [...onlineLocations, ...offlineLocations];
    
    // 削除条件を厳密化
    const allValidLocationIds = new Set([
        ...onlineLocations.map(loc => loc.participant_id),
        ...offlineLocations.map(loc => loc.participant_id)
    ]);
    
    const markersToRemove = [...currentMarkerIds].filter(id => {
        const location = locations.find(loc => loc.participant_id === id);
        if (!location) return true;
        
        const hasValidCoords = location.latitude !== null && 
                              location.longitude !== null && 
                              location.latitude !== 999.0 && 
                              location.longitude !== 999.0 &&
                              !isNaN(location.latitude) && 
                              !isNaN(location.longitude);
        
        if (location.status === 'waiting' && hasValidCoords) {
            return true;
        }
        
        return !hasValidCoords && !location.has_shared_before && location.status === 'waiting';
    });
    
    markersToRemove.forEach(id => {
        this.removeMarker(id);
    });

    // クラスタリング処理の前に、既存のクラスターが解除される場合の処理を追加
    const previousClusters = this.currentClusters || new Map();
    
    // クラスタリング
    const clusters = this.detectAndHandleClusters(allLocationsForClustering);
    
    // クラスターが解除された参加者をチェック
    previousClusters.forEach((prevCluster, prevClusterId) => {
        if (prevCluster.isCluster) {
            const currentCluster = clusters.get(prevClusterId);
            
            // クラスターが解除された場合
            if (!currentCluster || !currentCluster.isCluster) {
                // そのクラスターを追従していた場合は追従解除
                if (state.followingGroup) {
                    const wasFollowingThisCluster = prevCluster.participants.some(p => 
                        state.followingGroup.includes(p.participant_id)
                    );
                    
                    if (wasFollowingThisCluster) {
                        state.followingGroup = null;
                        state.followingParticipantId = null;
                        this.stopGroupFollowingTimer();
                    }
                }
            }
        }
    });
    
    // 現在のクラスタ状態を保存
    this.currentClusters = clusters;
    
    this.clearAllClusterConnections();
    
    // クラスタ内の参加者IDを記録
    const clusteredParticipantIds = new Set();
    
    clusters.forEach((cluster, clusterId) => {
        if (cluster.isCluster) {
            cluster.participants.forEach(p => clusteredParticipantIds.add(p.participant_id));
            this.updateClusterMarkers(cluster, clusterId);
        } else if (!clusteredParticipantIds.has(cluster.participants[0].participant_id)) {
            const participant = cluster.participants[0];
            const isOffline = participant.is_online === false || participant.status === 'stopped';
            
            const markerLocation = {
                ...participant,
                isOffline: isOffline,
                is_online: participant.is_online,
                isInCluster: false,
                clusterSize: 1
            };
            
            this.updateSingleMarker(markerLocation);
        }
    });
    
    this.validateMarkerStates(locations);
}
// === ★ ：マーカー状態の検証メソッド ===
validateMarkerStates(locations) {
    const markerCount = Object.keys(this.markers).length;
    const locationCount = locations.filter(loc => {
        const hasValidCoords = loc.latitude !== null && 
                              loc.longitude !== null && 
                              loc.latitude !== 999.0 && 
                              loc.longitude !== 999.0 &&
                              !isNaN(loc.latitude) && 
                              !isNaN(loc.longitude);
        
        const shouldShowMarker = (loc.is_online && loc.status === 'sharing') ||
                               (!loc.is_online && loc.has_shared_before);
        
        return hasValidCoords && shouldShowMarker;
    }).length;
    
    
    // 不整合があれば警告
    if (markerCount !== locationCount) {
        console.warn(`マーカー数不整合検出: 表示 ${markerCount} ≠ 期待 ${locationCount}`);
        
        // 詳細ログ
        Object.keys(this.markers).forEach(id => {
            const location = locations.find(loc => loc.participant_id === id);
            if (location) {
            } else {
                console.warn(`マーカー存在だが参加者データなし: ${id}`);
            }
        });
    }
}
    // クラスターマーカーの更新
    updateClusterMarkers(cluster, clusterId) {
    const participants = cluster.participants;
    const centerLat = cluster.centerLat;
    const centerLng = cluster.centerLng;

    let shouldAutoReopen = false;
    if (this.pendingClusterReopens) {
        shouldAutoReopen = this.pendingClusterReopens.has(clusterId);
    }

    // 接続線を描画（オフライン参加者も含む）
    this.drawClusterConnections(cluster, clusterId);

    // 各参加者を固定位置に配置（participant_idでソートして順序を固定）
    const sortedParticipants = participants.sort((a, b) => a.participant_id.localeCompare(b.participant_id));
    
    sortedParticipants.forEach((participant, index) => {
        const angle = (2 * Math.PI * index) / sortedParticipants.length;
        
        // 固定半径で円形配置
        const radius = CONFIG.CLUSTER_OFFSET_RADIUS;
        
        const offsetLat = centerLat + (radius * 0.00001) * Math.cos(angle);
        const offsetLng = centerLng + (radius * 0.00001) * Math.sin(angle);

        // オフライン状態を正しく判定
        const isOffline = participant.is_online === false || participant.status === 'stopped';

        // ★ 重要：クラスター内の参加者の移動アニメーションを事前に停止
        this.stopMovementAnimation(participant.participant_id);
        
        // ★ 重要：方向指示円も事前に削除
        if (this.directionIndicators[participant.participant_id]) {
            this.map.removeLayer(this.directionIndicators[participant.participant_id]);
            delete this.directionIndicators[participant.participant_id];
        }

        const offsetParticipant = {
            ...participant,
            latitude: offsetLat,
            longitude: offsetLng,
            isInCluster: true,
            clusterSize: sortedParticipants.length,
            clusterIndex: index,
            clusterCenter: { lat: centerLat, lng: centerLng },
            isOffline: isOffline,
            is_online: participant.is_online,
            forceShowClusterBadge: true
        };

        this.updateSingleMarker(offsetParticipant);
    });

    // 保留中の再表示処理（既存コード）
    if (shouldAutoReopen) {
        const connectionGroup = this.clusterConnections[clusterId];
        if (connectionGroup) {
            connectionGroup.eachLayer(layer => {
                if (layer instanceof L.Marker) {
                    this.processPendingClusterReopens(clusterId, layer, participants);
                }
            });
        }
    }
}
    // クラスター接続線を描画
    drawClusterConnections(cluster, clusterId) {
    // 既存の接続線を削除
    if (this.clusterConnections[clusterId]) {
        this.map.removeLayer(this.clusterConnections[clusterId]);
    }

    const participants = cluster.participants;
    if (participants.length < 2) return;

    const centerLat = cluster.centerLat;
    const centerLng = cluster.centerLng;

    // 参加者をソートして順序を固定（マーカー配置と同じ順序にする）
    const sortedParticipants = participants.sort((a, b) => a.participant_id.localeCompare(b.participant_id));

    // 参加者同士を繋ぐ線
    const connectionLines = [];
    sortedParticipants.forEach((participant, index) => {
        const angle = (2 * Math.PI * index) / sortedParticipants.length;
        const radius = CONFIG.CLUSTER_OFFSET_RADIUS;
        
        const offsetLat = centerLat + (radius * 0.00001) * Math.cos(angle);
        const offsetLng = centerLng + (radius * 0.00001) * Math.sin(angle);
        
        // ★ 修正：マーカーの最下部（ピンの先端）位置を計算
        // マーカーは高さ40px、アンカーが[20, 45]なので、45ピクセル下がピンの先端
        // 地図座標に変換（緯度方向に少し下げる）
        const markerBottomOffset = 0.00003; // マーカーの高さ分のオフセット
        const adjustedLat = offsetLat - markerBottomOffset;

        // 中心から各マーカーの最下部への線
        connectionLines.push({
            line: [[centerLat, centerLng], [adjustedLat, offsetLng]],
            participant: participant
        });
    });

    // グラデーション効果のある接続線
    const connectionGroup = L.layerGroup();
    connectionLines.forEach((connectionData, index) => {
        const participant = connectionData.participant;
        const isOffline = participant.is_online === false || participant.status === 'stopped';
        
        const lineColor = isOffline ? '#6c757d' : this.getParticipantColor(participant.participant_id);
        const lineOpacity = isOffline ? 0.3 : 0.5;  // ★ 修正：透明度を下げて目立たなくする
        const lineWeight = isOffline ? 2 : 3;  // ★ 修正：線を細くする
        const dashArray = isOffline ? '3, 8' : '5, 10';
        
        const polyline = L.polyline(connectionData.line, {
            color: lineColor,
            weight: lineWeight,
            opacity: lineOpacity,
            dashArray: dashArray,
            className: `cluster-connection-line ${isOffline ? 'offline-line' : 'online-line'}`,
            interactive: false,
            bubblingMouseEvents: false,
            pane: 'overlayPane'
        });

        // DOMレベルでもpointer-eventsを無効化
        polyline.on('add', () => {
            if (polyline._path) {
                polyline._path.style.pointerEvents = 'none';
                polyline._path.style.zIndex = '-1';
                if (isOffline) {
                    polyline._path.style.filter = 'grayscale(100%)';
                }
            }
        });

        connectionGroup.addLayer(polyline);
    });

    // ★ 修正：中心ピンの位置も調整（少し上に配置してバランスを取る）
    const centerPinOffset = 0.00001; // 中心ピンを少し上に配置
    const adjustedCenterLat = centerLat + centerPinOffset;
    
    const centerPinIcon = this.createClusterCenterPin(participants);
    const centerMarker = L.marker([adjustedCenterLat, centerLng], {
        icon: centerPinIcon,
        zIndexOffset: 1000 // マーカーは最上位に配置
    });

    // 以下、既存のポップアップ処理は変更なし
    const centerPopupContent = this.createClusterCenterPopup(participants, centerLat, centerLng);
    
    centerMarker.bindPopup(centerPopupContent, {
        closeButton: true,
        autoClose: false,
        closeOnClick: false,
        closeOnEscapeKey: true,
        keepInView: true,
        autoPan: false,
        maxWidth: 300,
        offset: [0, -15]
    });

    const wasOpen = this.isClusterPopupOpen(clusterId);
    
    centerMarker.on('click', (e) => {
        centerMarker.openPopup();
        this.trackOpenClusterPopup(clusterId, centerMarker, participants);
        L.DomEvent.stopPropagation(e);
    });

    centerMarker.on('popupclose', (e) => {
        this.untrackClusterPopup(clusterId);
        this.manuallyClosedClusters = this.manuallyClosedClusters || new Set();
        this.manuallyClosedClusters.add(clusterId);
        setTimeout(() => {
            if (this.manuallyClosedClusters) {
                this.manuallyClosedClusters.delete(clusterId);
            }
        }, 5000);
    });

    connectionGroup.addLayer(centerMarker);

    this.clusterConnections[clusterId] = connectionGroup;
    connectionGroup.addTo(this.map);
    
    if (wasOpen && !this.isManuallyClosedCluster(clusterId)) {
        setTimeout(() => {
            if (this.map.hasLayer(centerMarker)) {
                centerMarker.openPopup();
                this.trackOpenClusterPopup(clusterId, centerMarker, participants);
            } else {
                console.warn(`❌ マーカーがマップに存在しないため再表示失敗: ${clusterId}`);
            }
        }, 200);
    }
}

// ★ ：クラスターが手動で閉じられたかを確認
isManuallyClosedCluster(clusterId) {
    return (this.manuallyClosedClusters && this.manuallyClosedClusters.has(clusterId)) || false;
}

// ★ ：クラスターポップアップが現在開いているかを確認
isClusterPopupOpen(clusterId) {
    const tracked = this.openClusterPopups.get(clusterId);
    if (!tracked) return false;
    
    // マーカーが存在してポップアップが開いているかを確認
    if (tracked.marker && this.map.hasLayer(tracked.marker)) {
        const popup = tracked.marker.getPopup();
        return popup && this.map.hasLayer(popup);
    }
    
    return false;
}
    
    // ★ ：開いているクラスターポップアップを追跡
    trackOpenClusterPopup(clusterId, marker, participants) {
    const trackingInfo = {
        marker: marker,
        participants: participants.map(p => ({
            id: p.participant_id,
            name: p.participant_name || `参加者${p.participant_id.substring(0, 4)}`
        })),
        openedAt: Date.now(),
        clusterId: clusterId,
        centerLat: marker.getLatLng().lat,
        centerLng: marker.getLatLng().lng
    };
    
    this.openClusterPopups.set(clusterId, trackingInfo);
}
    
    // ★ ：クラスターポップアップの追跡を停止
    untrackClusterPopup(clusterId) {
    const tracked = this.openClusterPopups.get(clusterId);
    if (tracked) {
        this.openClusterPopups.delete(clusterId);
    }
}
    
    // ★ ：必要に応じてクラスターポップアップを再表示
    reopenClusterPopupIfNeeded(clusterId, newMarker, participants) {
        const tracked = this.openClusterPopups.get(clusterId);
        
        if (!tracked) return; // 追跡されていない場合はスキップ
        
        const participantIds = participants.map(p => p.participant_id);
        const trackedIds = tracked.participants;
        
        // 参加者構成をログ出力
        const sameParticipants = participantIds.length === trackedIds.length &&
                                participantIds.every(id => trackedIds.includes(id));
        
        if (!sameParticipants) {
        }
        
        // ★ 修正：参加者構成が変わっても×ボタンで閉じない限りは常に再表示
        setTimeout(() => {
            const statusMsg = sameParticipants ? '同じ構成で再表示' : '構成変更でも再表示';
            newMarker.openPopup();
            
            // 新しいマーカーと参加者構成で追跡情報を更新
            this.trackOpenClusterPopup(clusterId, newMarker, participants);
        }, 100); // 少し遅延させて確実に表示
    }
    
    // ★ ：全てのクラスターポップアップ追跡をクリア
    clearAllClusterPopupTracking() {
        this.openClusterPopups.clear();
    }
    
    // === 既存の clearAllClusterConnections メソッドを修正 ===
    clearAllClusterConnections() {
    // 開いているポップアップの情報を一時保存
    const openPopupsInfo = new Map();
    this.openClusterPopups.forEach((info, clusterId) => {
        if (this.isClusterPopupOpen(clusterId)) {
            openPopupsInfo.set(clusterId, {
                participants: info.participants,
                openedAt: info.openedAt
            });
        }
    });
    
    // 既存のクリーンアップ処理
    Object.keys(this.clusterConnections).forEach(clusterId => {
        if (this.clusterConnections[clusterId]) {
            this.map.removeLayer(this.clusterConnections[clusterId]);
        }
    });
    this.clusterConnections = {};
    
    // ポップアップ追跡情報をクリア
    this.openClusterPopups.clear();
    
    // 開いていたポップアップ情報を復元（次の再描画で使用）
    this.pendingClusterReopens = openPopupsInfo;
    
}

// ★ ：保留中のポップアップ再表示を処理
processPendingClusterReopens(clusterId, marker, participants) {
    if (!this.pendingClusterReopens) return false;
    
    const pendingInfo = this.pendingClusterReopens.get(clusterId);
    if (!pendingInfo) return false;
    
    
    // 参加者構成が同じかチェック
    const currentParticipantIds = participants.map(p => p.participant_id).sort();
    const pendingParticipantIds = pendingInfo.participants.map(p => p.id).sort();
    
    const sameComposition = currentParticipantIds.length === pendingParticipantIds.length &&
                           currentParticipantIds.every((id, index) => id === pendingParticipantIds[index]);
    
    if (sameComposition) {
        // 少し遅延させてポップアップを再表示
        setTimeout(() => {
            if (this.map.hasLayer(marker)) {
                marker.openPopup();
                this.trackOpenClusterPopup(clusterId, marker, participants);
            }
        }, 150);
        
        // 処理済みなので削除
        this.pendingClusterReopens.delete(clusterId);
        return true;
    }
    
    this.pendingClusterReopens.delete(clusterId);
    return false;
}

// === ：クラスター中心ピンアイコン作成 ===
createClusterCenterPin(participants) {
    const memberCount = participants.length;
    

    const baseColor = '#FFD700';
    
    const pinHtml = `
        <div class="cluster-center-pin" style="
            position: relative;
            width: 48px;
            height: 48px;
            display: flex;
            align-items: center;
            justify-content: center;
        ">
            <!-- マップピンのSVGアイコン -->
            <svg width="48" height="48" viewBox="0 0 24 24" style="
                filter: drop-shadow(0 4px 8px rgba(0,0,0,0.3));
                animation: clusterPinPulse 2s infinite ease-in-out;
            ">
                <path fill="${baseColor}" stroke="white" stroke-width="2" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                <circle cx="12" cy="9" r="2.5" fill="white"/>
            </svg>
            
            <!-- メンバー数バッジ -->
            <div style="
                position: absolute;
                top: -8px;
                right: -8px;
                background: linear-gradient(135deg, #ff6b6b, #ee5a52);
                color: white;
                font-size: 12px;
                font-weight: bold;
                padding: 4px 6px;
                border-radius: 50%;
                min-width: 24px;
                height: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                border: 2px solid white;
                box-shadow: 0 2px 8px rgba(255, 107, 107, 0.4);
                animation: clusterBadgeBounce 1.5s infinite;
            ">
                ${memberCount}
            </div>
            
            <!-- 集合アイコン -->
            <div style="
                position: absolute;
                bottom: -6px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 16px;
                animation: clusterIconFloat 2.5s infinite ease-in-out;
            ">👥</div>
        </div>
        
        <style>
            @keyframes clusterPinPulse {
                0%, 100% { 
                    transform: scale(1);
                    opacity: 1;
                }
                50% { 
                    transform: scale(1.05);
                    opacity: 0.9;
                }
            }
            
            @keyframes clusterBadgeBounce {
                0%, 100% { transform: scale(1) rotate(0deg); }
                25% { transform: scale(1.1) rotate(-5deg); }
                75% { transform: scale(1.05) rotate(5deg); }
            }
            
            @keyframes clusterIconFloat {
                0%, 100% { transform: translateX(-50%) translateY(0px); }
                50% { transform: translateX(-50%) translateY(-3px); }
            }
        </style>
    `;
    
    return L.divIcon({
        html: pinHtml,
        className: 'cluster-center-pin-icon',
        iconSize: [48, 48],
        iconAnchor: [24, 48], // ピンの先端を中心座標に合わせる
        popupAnchor: [0, -48]
    });
}

// === マップ管理クラス - createClusterCenterPopup メソッドの修正 ===
createClusterCenterPopup(participants, centerLat, centerLng) {
    const popupDiv = document.createElement('div');
    popupDiv.style.minWidth = '200px';
    popupDiv.style.maxWidth = '400px';
    
    // ★ 修正：オンライン・オフラインの数をカウント
    const onlineCount = participants.filter(p => p.is_online === true && p.status === 'sharing').length;
    const offlineCount = participants.filter(p => p.is_online === false || p.status === 'stopped').length;
    
    // ヘッダー
    const headerDiv = document.createElement('div');
    headerDiv.style.cssText = `
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 8px 12px;
        margin: -9px -12px 12px -12px;
        border-radius: 8px 8px 0 0;
        font-weight: bold;
        text-align: center;
    `;
    
    // ★ 修正：オンライン・オフラインの内訳を表示
    let headerText = `<i class="fas fa-users"></i> グループ集合地点 (${participants.length}人)`;
    if (offlineCount > 0) {
        headerText += `<br><small style="font-weight: normal;">オンライン: ${onlineCount}人 / オフライン: ${offlineCount}人</small>`;
    }
    headerDiv.innerHTML = headerText;
    popupDiv.appendChild(headerDiv);
    
    // 座標情報
    const locationDiv = document.createElement('div');
    locationDiv.style.cssText = 'margin-bottom: 12px; font-size: 12px; color: #666;';
    locationDiv.innerHTML = `
        📍 ${centerLat.toFixed(6)}, ${centerLng.toFixed(6)}<br>
        <small>※ メンバーの中心座標</small>
    `;
    popupDiv.appendChild(locationDiv);
    
    // メンバーリスト
    const membersDiv = document.createElement('div');
    membersDiv.innerHTML = '<strong style="color: #333;">📝 メンバー:</strong>';
    popupDiv.appendChild(membersDiv);
    
    const membersList = document.createElement('ul');
    membersList.style.cssText = `
        margin: 8px 0 0 0; 
        padding-left: 16px; 
        max-height: ${participants.length > 5 ? '120px' : 'auto'}; 
        overflow-y: ${participants.length > 5 ? 'auto' : 'visible'};
    `;
    
    // ★ 修正：オンライン→オフラインの順でソート
    const sortedByStatus = [...participants].sort((a, b) => {
        const aOnline = a.is_online === true && a.status === 'sharing';
        const bOnline = b.is_online === true && b.status === 'sharing';
        if (aOnline && !bOnline) return -1;
        if (!aOnline && bOnline) return 1;
        return 0;
    });
    
    sortedByStatus.forEach((participant, index) => {
        const li = document.createElement('li');
        const color = this.getParticipantColor(participant.participant_id);
        const name = (participant.participant_name || `参加者${participant.participant_id.substring(0, 4)}`).substring(0, 25);
        const isOffline = participant.is_online === false || participant.status === 'stopped';
        
        li.style.cssText = 'margin-bottom: 4px; font-size: 13px;';
        li.innerHTML = `
            <span style="
                display: inline-block;
                width: 12px;
                height: 12px;
                background: ${isOffline ? '#6c757d' : color};
                border-radius: 50%;
                margin-right: 6px;
                vertical-align: middle;
                opacity: ${isOffline ? '0.6' : '1'};
            "></span>
            <strong style="color: ${isOffline ? '#6c757d' : color};">
                ${name}
                ${isOffline ? ' <span style="font-weight: normal; font-size: 11px;">(オフライン)</span>' : ''}
            </strong>
            ${participant.participant_id === state.participantId ? '<span style="color: #007bff; font-size: 11px;">(自分)</span>' : ''}
        `;
        membersList.appendChild(li);
    });
    
    popupDiv.appendChild(membersList);
    
    // 以下、既存のアクションボタン部分は変更なし
    const actionsDiv = document.createElement('div');
    actionsDiv.style.cssText = `
        margin-top: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: stretch;
    `;
    
    const topButtonsDiv = document.createElement('div');
    topButtonsDiv.style.cssText = `
        display: flex;
        gap: 6px;
        align-items: stretch;
    `;
    
    const focusButton = document.createElement('button');
    focusButton.className = 'btn btn-sm btn-primary';
    focusButton.innerHTML = '<i class="fas fa-crosshairs"></i> 追従';
    focusButton.style.cssText = `
        flex: 1;
        min-height: 32px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: all 0.2s ease;
        font-size: 12px;
    `;
    
    const resetButton = document.createElement('button');
    resetButton.className = 'btn btn-sm btn-outline-secondary';
    resetButton.innerHTML = '<i class="fas fa-expand-arrows-alt"></i> 全体';
    resetButton.style.cssText = `
        flex: 1;
        min-height: 32px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: all 0.2s ease;
        font-size: 12px;
    `;
    
    const navigationButton = document.createElement('button');
    navigationButton.className = 'btn btn-sm btn-success';
    navigationButton.innerHTML = '<i class="fas fa-route"></i> Google Mapsで集合地点に案内';
    navigationButton.style.cssText = `
        width: 100%;
        min-height: 34px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: all 0.2s ease;
        font-size: 13px;
        font-weight: 500;
    `;
    
    const updateButtonStates = () => {
        const isFollowingGroup = state.followingGroup && 
            state.followingGroup.some(id => participants.map(p => p.participant_id).includes(id));
        
        resetButton.innerHTML = '<i class="fas fa-expand-arrows-alt"></i> 全体';
        resetButton.className = 'btn btn-sm btn-outline-secondary';
        resetButton.disabled = false;
        resetButton.style.cssText = `
            flex: 1;
            min-height: 32px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: all 0.2s ease;
            font-size: 12px;
            opacity: 1;
            cursor: pointer;
        `;
        
        actionsDiv.style.display = 'none';
        actionsDiv.offsetHeight;
        actionsDiv.style.display = 'flex';
        
    };
    
    focusButton.onclick = () => {
        this.startGroupFollowing(participants);
        
        focusButton.style.transform = 'scale(0.95)';
        setTimeout(() => {
            updateButtonStates();
            focusButton.style.transform = 'scale(1)';
        }, 100);
        
        this.map.closePopup();
    };
    
    resetButton.onclick = () => {
        this.focusOnGroupOnly(participants);
        
        resetButton.innerHTML = '<i class="fas fa-check"></i> ✓';
        resetButton.className = 'btn btn-sm btn-success';
        resetButton.disabled = true;
        resetButton.style.cssText = `
            flex: 1;
            min-height: 32px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: all 0.2s ease;
            font-size: 12px;
            opacity: 0.8;
            cursor: not-allowed;
        `;
        
        actionsDiv.style.display = 'none';
        actionsDiv.offsetHeight;
        actionsDiv.style.display = 'flex';
        
        setTimeout(() => {
            updateButtonStates();
        }, 1000);
        
        this.map.closePopup();
    };
    
    navigationButton.onclick = () => {
        this.openGoogleMapsNavigationToClusterCenter(centerLat, centerLng, participants);
        
        navigationButton.innerHTML = '<i class="fas fa-check"></i> 案内を開始しました';
        navigationButton.className = 'btn btn-sm btn-success';
        navigationButton.disabled = true;
        navigationButton.style.opacity = '0.8';
        
        setTimeout(() => {
            navigationButton.innerHTML = '<i class="fas fa-route"></i> Google Mapsで集合地点に案内';
            navigationButton.className = 'btn btn-sm btn-success';
            navigationButton.disabled = false;
            navigationButton.style.opacity = '1';
        }, 2000);
        
        setTimeout(() => {
            this.map.closePopup();
        }, 1500);
    };
    
    navigationButton.onmouseenter = () => {
        if (!navigationButton.disabled) {
            navigationButton.style.transform = 'scale(1.02)';
            navigationButton.style.boxShadow = '0 4px 12px rgba(40, 167, 69, 0.3)';
        }
    };
    
    navigationButton.onmouseleave = () => {
        navigationButton.style.transform = 'scale(1)';
        navigationButton.style.boxShadow = 'none';
    };
    
    const buttonUpdateInterval = setInterval(() => {
        if (popupDiv.closest('.leaflet-popup-content')) {
            const previousFollowingState = focusButton.disabled;
            updateButtonStates();
            
            if (previousFollowingState !== focusButton.disabled) {
            }
        } else {
            clearInterval(buttonUpdateInterval);
        }
    }, 1000);
    
    updateButtonStates();
    
    topButtonsDiv.appendChild(focusButton);
    topButtonsDiv.appendChild(resetButton);
    
    actionsDiv.appendChild(topButtonsDiv);
    actionsDiv.appendChild(navigationButton);
    
    popupDiv.appendChild(actionsDiv);
    
    popupDiv.style.cssText = `
        min-width: 200px;
        max-width: 300px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
        line-height: 1.4;
        overflow: visible;
    `;
    
    return popupDiv;
}

// ★ ：集合地点へのGoogle Maps案内メソッド
openGoogleMapsNavigationToClusterCenter(centerLat, centerLng, participants) {
    const memberNames = participants
        .map(p => (p.participant_name || `参加者${p.participant_id.substring(0, 4)}`).substring(0, 15))
        .join(', ');
    
    const shortMemberNames = memberNames.length > 50 ? 
        memberNames.substring(0, 47) + '...' : 
        memberNames;
    
    const locationName = `グループ集合地点 (${participants.length}人: ${shortMemberNames})`;
    
    // Google Maps URLを構築
    const destination = `${centerLat},${centerLng}`;
    
    // モバイルデバイスかどうかを判定
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    
    let mapsUrl;
    
    if (isMobile) {
        // モバイルの場合：Google Mapsアプリを優先
        mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=walking`;
    } else {
        // デスクトップの場合：ブラウザ版Google Maps
        mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=walking`;
    }
    
    // 新しいタブ/ウィンドウで開く
    const opened = window.open(mapsUrl, '_blank', 'noopener,noreferrer');
    
    if (opened) {
        
        // 通知も表示
        ui.showNotification(
            `${participants.length}人の集合地点への案内を開始しました`,
            'success',
            'fas fa-route'
        );
    } else {
        console.warn('Google Mapsの起動に失敗しました');
        // ui.showNotification(
        //     'Google Mapsの起動に失敗しました',
        //     'warning',
        //     'fas fa-exclamation-triangle'
        // );
    }
}
// === ：グループのみ全体表示機能 ===
focusOnGroupOnly(participants) {
    if (!participants || participants.length === 0) return;
    
    // グループ内の全マーカーを取得
    const groupMarkers = participants
        .map(p => this.markers[p.participant_id])
        .filter(marker => marker);

    if (groupMarkers.length === 0) return;

    const group = new L.featureGroup(groupMarkers);
    const bounds = group.getBounds();
    
    if (bounds.isValid()) {
        // グループのみを適切な余白で表示
        this.map.fitBounds(bounds.pad(0.15));
    }
    
    // 追従はリセット（全体表示のため）
    state.followingParticipantId = null;
    state.followingGroup = null;
    this.stopGroupFollowingTimer();
    state.autoFitEnabled = false; // 自動調整は無効のまま
}
// === ：グループ追従機能 ===
startGroupFollowing(participants) {
    
    // グループ追従用の特別なIDを設定
    const groupId = `group_${participants.map(p => p.participant_id).sort().join('_').substring(0, 20)}`;
    state.followingParticipantId = groupId;
    state.followingGroup = participants.map(p => p.participant_id);
    
    // ★ 修正：初回フォーカス時も現在の拡大率でグループ中心に移動
    this.followGroupWithCurrentZoom(participants);
    
    // グループ追従タイマーを開始
    this.startGroupFollowingTimer();
}

// === ：グループ追従タイマー ===
startGroupFollowingTimer() {
    // 既存のタイマーをクリア
    if (this.groupFollowingTimer) {
        clearInterval(this.groupFollowingTimer);
        this.groupFollowingTimer = null;
    }

    this.groupFollowingTimer = setInterval(() => {
        // グループ追従中でない場合は停止
        if (!state.followingGroup || state.followingGroup.length === 0) {
            this.stopGroupFollowingTimer();
            return;
        }
        
        // 現在の参加者データからグループメンバーを取得
        const groupMembers = state.participantsData.filter(p => 
            state.followingGroup.includes(p.participant_id) &&
            p.status === 'sharing' &&
            p.latitude !== null && 
            p.longitude !== null &&
            p.latitude !== 999.0 && 
            p.longitude !== 999.0 &&
            !isNaN(p.latitude) && 
            !isNaN(p.longitude)
        );
        
        // グループメンバーが存在しない場合も追従停止
        if (groupMembers.length === 0) {
            this.stopGroupFollowingTimer();
            return;
        }
        
        // 現在の拡大率を維持してグループの中心に移動
        this.followGroupWithCurrentZoom(groupMembers);
    }, 1000); // 1秒間隔で追従
}
// === ：現在の拡大率でグループ追従 ===
followGroupWithCurrentZoom(participants) {
    if (!participants || participants.length === 0) return;
    
    // グループの中心座標を計算
    const centerLat = participants.reduce((sum, p) => sum + p.latitude, 0) / participants.length;
    const centerLng = participants.reduce((sum, p) => sum + p.longitude, 0) / participants.length;
    
    // 現在の拡大率を維持してグループ中心に移動
    const currentZoom = this.map.getZoom();
    this.map.setView([centerLat, centerLng], currentZoom);
    
}
// === ：グループ追従タイマー停止 ===
stopGroupFollowingTimer() {
    
    if (this.groupFollowingTimer) {
        clearInterval(this.groupFollowingTimer);
        this.groupFollowingTimer = null;
    }
    
    // 追従状態もクリア
    state.followingGroup = null;
    state.followingParticipantId = null;
}

// === ：クラスター全体にフォーカスするメソッド ===
focusOnCluster(participants) {
    if (!participants || participants.length === 0) return;
    
    // クラスター内の全マーカーを取得
    const clusterMarkers = participants
        .map(p => this.markers[p.participant_id])
        .filter(marker => marker);

    const group = new L.featureGroup(clusterMarkers);
    const bounds = group.getBounds();
    if (bounds.isValid()) {
        this.map.fitBounds(bounds.pad(0.2));
    }
    
    // グループ追従用のIDは維持
    // state.followingParticipantId = null; // この行を削除
    state.autoFitEnabled = false;
}


    removeMarker(participantId) {
        
        this.stopRegularAnimation(participantId);

        // 移動アニメーションを停止
        this.stopMovementAnimation(participantId);
        
        // 前回位置を削除
        delete this.previousPositions[participantId];
        
        if (this.markers[participantId]) {
            this.map.removeLayer(this.markers[participantId]);
            delete this.markers[participantId];
        }
        if (this.markers[participantId]) {
            this.map.removeLayer(this.markers[participantId]);
            delete this.markers[participantId];
        }
        
        if (this.accuracyCircles[participantId]) {
            this.map.removeLayer(this.accuracyCircles[participantId]);
            delete this.accuracyCircles[participantId];
        }
        
        if (this.animationCircles[participantId]) {
            this.map.removeLayer(this.animationCircles[participantId]);
            delete this.animationCircles[participantId];
        }

        // クラスター関連の削除
        Object.keys(this.clusterConnections).forEach(clusterId => {
            if (clusterId.includes(participantId)) {
                this.map.removeLayer(this.clusterConnections[clusterId]);
                delete this.clusterConnections[clusterId];
            }
        });

        Object.keys(this.pulseAnimations).forEach(pulseId => {
            if (pulseId.includes(participantId)) {
                clearInterval(this.pulseAnimations[pulseId].interval);
                if (this.pulseAnimations[pulseId].circle) {
                    this.map.removeLayer(this.pulseAnimations[pulseId].circle);
                }
                delete this.pulseAnimations[pulseId];
            }
        });
    }
    
    removeOwnMarker() {
        
        this.removeMarker(state.participantId);
        
        // 参加者データからも位置情報を削除
        state.participantsData = state.participantsData.map(p => {
            if (p.participant_id === state.participantId) {
                return {
                    ...p,
                    latitude: null,
                    longitude: null,
                    accuracy: null,
                    status: 'waiting',
                    is_online: true
                };
            }
            return p;
        });
        
        participantManager.updateList(state.participantsData);
    }
getCurrentClusterInfo(participantId) {
    // ★修正：currentClustersを使用
    if (!this.currentClusters) return null;
    
    for (const [clusterId, cluster] of this.currentClusters) {
        if (cluster.isCluster) {
            const participant = cluster.participants.find(p => p.participant_id === participantId);
            if (participant) {
                return {
                    clusterId: clusterId,
                    clusterCenter: { lat: cluster.centerLat, lng: cluster.centerLng },
                    participants: cluster.participants,
                    participantIndex: cluster.participants.findIndex(p => p.participant_id === participantId)
                };
            }
        }
    }
    return null;
}
updateSingleMarker(location) {
    const originalName = location.participant_name || `参加者${location.participant_id.substring(0, 4)}`;
    const name = originalName.substring(0, 30);
    const color = this.getParticipantColor(location.participant_id);
    const isBackground = location.is_background || false;
    const stayMinutes = location.stay_minutes || 0;
    const isInCluster = location.isInCluster || false;
    const clusterSize = location.clusterSize || 1;
    
    const isOffline = location.isOffline || (!location.is_online && location.has_shared_before);
    
    // クラスター情報を取得
    const clusterInfo = this.getCurrentClusterInfo(location.participant_id);
    let actualLat = location.latitude;
    let actualLng = location.longitude;
    
    // クラスタ内の場合は配置座標を計算
    if (clusterInfo) {
        const sortedParticipants = clusterInfo.participants.sort((a, b) => 
            a.participant_id.localeCompare(b.participant_id)
        );
        const participantIndex = sortedParticipants.findIndex(p => 
            p.participant_id === location.participant_id
        );
        
        if (participantIndex !== -1) {
            const angle = (2 * Math.PI * participantIndex) / sortedParticipants.length;
            const radius = CONFIG.CLUSTER_OFFSET_RADIUS;
            
            actualLat = clusterInfo.clusterCenter.lat + (radius * 0.00001) * Math.cos(angle);
            actualLng = clusterInfo.clusterCenter.lng + (radius * 0.00001) * Math.sin(angle);
        }
    }
    
    // 移動速度計算の改善
    let movementSpeed = 0;
    let speedReliable = false;
    let isMoving = false;
    
    const previousPos = this.previousPositions[location.participant_id];
    const currentPos = [actualLat, actualLng];
    
    
    // 初期化
    if (!this.lastUpdateTimes) this.lastUpdateTimes = {};
    if (!this.positionHistory) this.positionHistory = {};
    if (!this.speedHistory) this.speedHistory = {};
    if (!this.lastSignificantMove) this.lastSignificantMove = {};
    if (!this.movementStopTimers) this.movementStopTimers = {};
    
    if (!this.positionHistory[location.participant_id]) {
        this.positionHistory[location.participant_id] = [];
    }
    
    const currentTime = Date.now();
    const positionEntry = {
        position: currentPos,
        time: currentTime,
        accuracy: location.accuracy || 50
    };
    
    let isFirstUpdate = !previousPos;
    
    // クラスタ内の場合は実際の座標での移動距離を計算（速度計算用）
    let actualMovementDistance = 0;
    if (!isFirstUpdate && previousPos && !clusterInfo && !isInCluster) {
        // クラスタ外の場合のみ移動距離を計算
        actualMovementDistance = this.calculateDistance(
            previousPos[0], previousPos[1],
            currentPos[0], currentPos[1]
        );
    } else if (!isFirstUpdate && (clusterInfo || isInCluster)) {
        // クラスタ内の場合は元の座標で移動距離を計算（速度計算のため）
        const prevOriginalPos = this.originalPositions?.[location.participant_id];
        if (prevOriginalPos) {
            actualMovementDistance = this.calculateDistance(
                prevOriginalPos[0], prevOriginalPos[1],
                location.latitude, location.longitude
            );
        }
    }
    
    // クラスタ内の場合は移動判定を特別処理
    if (clusterInfo || isInCluster) {
        isMoving = false;
        movementSpeed = 0;
        speedReliable = false;
        
        // 方向指示を削除
        if (this.directionIndicators[location.participant_id]) {
            this.map.removeLayer(this.directionIndicators[location.participant_id]);
            delete this.directionIndicators[location.participant_id];
        }
        
        // ただし、実際の移動速度は計算（表示用）
        if (!isOffline && location.is_online && location.status === 'sharing') {
            const originalPrevPos = this.originalPositions?.[location.participant_id];
            if (originalPrevPos && actualMovementDistance >= 1) {
                const timeDiff = (currentTime - (this.lastUpdateTimes[location.participant_id] || currentTime)) / 1000;
                if (timeDiff >= 1) {
                    const rawSpeed = (actualMovementDistance / timeDiff) * 3.6;
                    if (rawSpeed >= 3 && rawSpeed < 200) {
                        movementSpeed = Math.round(rawSpeed * 10) / 10;
                    }
                }
            }
        }
    } else if (!isFirstUpdate && previousPos && actualMovementDistance < CONFIG.MOVEMENT_THRESHOLD) {
        
        if (this.markers[location.participant_id]) {
            const marker = this.markers[location.participant_id];
            marker.setIcon(this.createCustomMarker(name, color, isBackground, stayMinutes, isInCluster, clusterSize, 0, isOffline, 0, false));
            const popupContent = this.createPopupContent(location, name, color, stayMinutes, isBackground, isInCluster, clusterSize, 0, false);
            marker.bindPopup(popupContent);
            
            if (this.directionIndicators[location.participant_id]) {
                this.map.removeLayer(this.directionIndicators[location.participant_id]);
                delete this.directionIndicators[location.participant_id];
            }
            
            if (!isOffline && !isInCluster && location.status === 'sharing') {
                if (!this.regularAnimationIntervals[location.participant_id]) {
                    this.startRegularAnimationForStationary(location.participant_id, actualLat, actualLng, color, location.accuracy);
                }
                this.updateAccuracyCircle(location.participant_id, actualLat, actualLng, location.accuracy, color);
            }
        }
        
        return;
    }
    
    // クラスタ外での通常の速度計算
    if (!isOffline && location.is_online && location.status === 'sharing' && !clusterInfo && !isInCluster) {
        this.positionHistory[location.participant_id].push(positionEntry);
        
        const cutoffTime = currentTime - 15000;
        this.positionHistory[location.participant_id] = 
            this.positionHistory[location.participant_id].filter(entry => entry.time > cutoffTime);
        
        const history = this.positionHistory[location.participant_id];
        
        let isStationary = isFirstUpdate;
        
        if (!isFirstUpdate) {
            const threeSecondsAgo = currentTime - 3000;
            const recentHistory = history.filter(entry => entry.time > threeSecondsAgo);
            
            if (recentHistory.length >= 2) {
                const oldestRecent = recentHistory[0];
                const newestRecent = recentHistory[recentHistory.length - 1];
                
                const recentDistance = this.calculateDistance(
                    oldestRecent.position[0], oldestRecent.position[1],
                    newestRecent.position[0], newestRecent.position[1]
                );
                
                if (recentDistance < 3) {
                    isStationary = true;
                    if (this.directionIndicators[location.participant_id]) {
                        this.map.removeLayer(this.directionIndicators[location.participant_id]);
                        delete this.directionIndicators[location.participant_id];
                    }
                }
            }
        }
        
        if (!isFirstUpdate && previousPos && !isStationary && actualMovementDistance >= CONFIG.MOVEMENT_THRESHOLD) {
            this.lastSignificantMove[location.participant_id] = currentTime;
            isMoving = true;
        } else {
            isMoving = false;
            
            if (this.directionIndicators[location.participant_id]) {
                this.map.removeLayer(this.directionIndicators[location.participant_id]);
                delete this.directionIndicators[location.participant_id];
            }
        }
        
        if (!isStationary && history.length >= 2 && isMoving) {
            const oldestPoint = history[0];
            const newestPoint = history[history.length - 1];
            
            const distance = this.calculateDistance(
                oldestPoint.position[0], oldestPoint.position[1],
                newestPoint.position[0], newestPoint.position[1]
            );
            
            const timeDiff = (newestPoint.time - oldestPoint.time) / 1000;
            
            if (timeDiff >= 2 && distance >= 2) {
                const rawSpeed = (distance / timeDiff) * 3.6;
                const avgAccuracy = (oldestPoint.accuracy + newestPoint.accuracy) / 2;
                const accuracyFactor = Math.max(0.5, Math.min(1, 50 / avgAccuracy));
                
                if (rawSpeed < 200 && rawSpeed >= 0.5) {
                    movementSpeed = rawSpeed * accuracyFactor;
                    speedReliable = timeDiff >= 5 && avgAccuracy <= 50;
                    
                    if (!this.speedHistory[location.participant_id]) {
                        this.speedHistory[location.participant_id] = [];
                    }
                    
                    this.speedHistory[location.participant_id].push(movementSpeed);
                    if (this.speedHistory[location.participant_id].length > 3) {
                        this.speedHistory[location.participant_id].shift();
                    }
                    
                    const avgSpeed = this.speedHistory[location.participant_id].reduce((a, b) => a + b, 0) / 
                                    this.speedHistory[location.participant_id].length;
                    
                    movementSpeed = Math.round(avgSpeed * 10) / 10;
                }
            }
        }
        
        if (isStationary || !isMoving) {
            movementSpeed = 0;
            speedReliable = false;
            isMoving = false;
            if (this.speedHistory[location.participant_id]) {
                this.speedHistory[location.participant_id] = [];
            }
            this.startMovementStopTimer(location.participant_id);
        } else if (isMoving) {
            this.clearMovementStopTimer(location.participant_id);
        }
        
        this.lastUpdateTimes[location.participant_id] = currentTime;
    } else {
        if (this.positionHistory[location.participant_id]) {
            this.positionHistory[location.participant_id] = [];
        }
        if (this.speedHistory[location.participant_id]) {
            this.speedHistory[location.participant_id] = [];
        }
        if (this.lastSignificantMove[location.participant_id]) {
            delete this.lastSignificantMove[location.participant_id];
        }
        isMoving = false;
        this.clearMovementStopTimer(location.participant_id);
    }
    
    const popupContent = this.createPopupContent(location, name, color, stayMinutes, isBackground, isInCluster, clusterSize, isMoving ? movementSpeed : 0, speedReliable);
    
    if (this.markers[location.participant_id]) {
        const marker = this.markers[location.participant_id];
        
        // クラスタ内の場合は常にクラスタ配置位置を使用
        if (clusterInfo || isInCluster) {
            marker.setLatLng(currentPos);
            this.stopMovementAnimation(location.participant_id);
        } else if (!isFirstUpdate && previousPos && !isOffline && isMoving && actualMovementDistance >= CONFIG.MOVEMENT_THRESHOLD) {
            const bearing = this.calculateBearing(
                previousPos[0], previousPos[1],
                currentPos[0], currentPos[1]
            );
            
            this.animateMarkerMovement(
                location.participant_id,
                marker,
                previousPos,
                currentPos,
                bearing,
                color,
                true
            );
        } else {
            marker.setLatLng(currentPos);
            
            if (this.directionIndicators[location.participant_id]) {
                this.map.removeLayer(this.directionIndicators[location.participant_id]);
                delete this.directionIndicators[location.participant_id];
            }
            
            this.stopMovementAnimation(location.participant_id);
        }
        
        marker.setIcon(this.createCustomMarker(name, color, isBackground, stayMinutes, isInCluster, clusterSize, 0, isOffline, isMoving ? movementSpeed : 0, speedReliable));
        marker.bindPopup(popupContent);
        
        if (state.followingParticipantId === location.participant_id) {
            this.map.panTo(currentPos);
        }
    } else {
        const customIcon = this.createCustomMarker(name, color, isBackground, stayMinutes, isInCluster, clusterSize, 0, isOffline, isMoving ? movementSpeed : 0, speedReliable);
        const marker = L.marker(currentPos, {
            icon: customIcon
        })
        .addTo(this.map)
        .bindPopup(popupContent);
        
        if (!isOffline) {
            marker.on('click', () => {
                state.followingParticipantId = location.participant_id;
                const currentLatLng = marker.getLatLng();
                this.map.setView([currentLatLng.lat, currentLatLng.lng], Math.max(this.map.getZoom(), 15));
            });
        }
        
        this.markers[location.participant_id] = marker;
        this.lastUpdateTimes[location.participant_id] = currentTime;
        this.lastSignificantMove[location.participant_id] = currentTime;
        
        isMoving = false;
    }
    
    // 現在位置を記録（クラスタ配置済みの座標）
    this.previousPositions[location.participant_id] = currentPos;
    
    // 元の座標も保存（速度計算用）
    if (!this.originalPositions) this.originalPositions = {};
    this.originalPositions[location.participant_id] = [location.latitude, location.longitude];
    
    // 円アニメーション処理（クラスター内の場合はスキップ）
    if (!isOffline && !clusterInfo && !isInCluster && location.status === 'sharing') {
        this.updateAccuracyCircle(location.participant_id, actualLat, actualLng, location.accuracy, color);
        
        if (isMoving) {
            this.createRippleAnimation(location.participant_id, actualLat, actualLng, color, location.accuracy);
            this.stopRegularAnimation(location.participant_id);
        } else {
            this.startRegularAnimationForStationary(location.participant_id, actualLat, actualLng, color, location.accuracy);
        }
    } else {
        this.stopRegularAnimation(location.participant_id);
        
        if (this.accuracyCircles[location.participant_id]) {
            this.map.removeLayer(this.accuracyCircles[location.participant_id]);
            delete this.accuracyCircles[location.participant_id];
        }
        
        if (this.animationCircles[location.participant_id]) {
            this.map.removeLayer(this.animationCircles[location.participant_id]);
            delete this.animationCircles[location.participant_id];
        }
    }
}

startRegularAnimationForStationary(participantId, latitude, longitude, color, accuracy) {
    // 既存のインターバルがあればクリア
    if (this.regularAnimationIntervals[participantId]) {
        clearInterval(this.regularAnimationIntervals[participantId]);
        delete this.regularAnimationIntervals[participantId];
    }
    
    // 即座に1回実行
    this.createRippleAnimation(participantId, latitude, longitude, color, accuracy);
    
    // 3秒ごとの定期更新を設定
    this.regularAnimationIntervals[participantId] = setInterval(() => {
        // オンラインかつ共有中のみアニメーション
        const participant = state.participantsData.find(p => p.participant_id === participantId);
        if (participant && participant.is_online && participant.status === 'sharing') {
            this.createRippleAnimation(participantId, latitude, longitude, color, accuracy);
        } else {
            // オフラインまたは未共有になったらインターバルを停止
            clearInterval(this.regularAnimationIntervals[participantId]);
            delete this.regularAnimationIntervals[participantId];
        }
    }, 3000); // 3秒ごと
}

// 移動停止タイマーを開始
startMovementStopTimer(participantId) {
    // 既存のタイマーをクリア
    this.clearMovementStopTimer(participantId);
    
    // 既に停止判定済みの場合は即座に方向指示を削除
    if (!this.directionIndicators[participantId]) {
        return;
    }
    // タイマーは設定するが、実際の削除は次の更新で停止が確認された時に行う
    this.movementStopTimers[participantId] = {
        startTime: Date.now(),
        stopped: true
    };
}

// 移動停止タイマーをクリア
clearMovementStopTimer(participantId) {
    if (this.movementStopTimers[participantId]) {
        delete this.movementStopTimers[participantId];
    }
}

// 方位角計算
calculateBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    
    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
              Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    
    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
}

// 滑らかな移動アニメーション
animateMarkerMovement(participantId, marker, fromPos, toPos, bearing, color, isMoving = false) {
    // クラスター内の参加者は即座に新しい位置に移動（アニメーションなし）
    const participant = state.participantsData.find(p => p.participant_id === participantId);
    if (participant && participant.isInCluster) {
        marker.setLatLng(toPos);
        return;
    }
    
    // ★ ：移動距離をチェック
    const distance = this.calculateDistance(
        fromPos[0], fromPos[1],
        toPos[0], toPos[1]
    );
    
    // ★ 1m未満の移動はアニメーションなしで即座に更新
    if (distance < 1) {
        marker.setLatLng(toPos);
        // 方向指示も更新しない
        return;
    }
    
    // 既存のアニメーションを停止
    if (this.movementTrackers[participantId]) {
        cancelAnimationFrame(this.movementTrackers[participantId].animationId);
    }
    
    // 移動中の場合は方向指示円を作成/更新
    if (isMoving) {
        this.createDirectionIndicator(participantId, fromPos, bearing, color);
    }
    
    const duration = 1000; // 1秒でアニメーション
    const startTime = Date.now();
    
    const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // イージング関数（ease-out）
        const easeProgress = 1 - Math.pow(1 - progress, 3);
        
        // 中間位置を計算
        const currentLat = fromPos[0] + (toPos[0] - fromPos[0]) * easeProgress;
        const currentLng = fromPos[1] + (toPos[1] - fromPos[1]) * easeProgress;
        
        marker.setLatLng([currentLat, currentLng]);
        
        // 方向指示円も一緒に移動（移動中の場合のみ）
        if (this.directionIndicators[participantId] && isMoving) {
            this.directionIndicators[participantId].setLatLng([currentLat, currentLng]);
        }
        
        if (progress < 1) {
            this.movementTrackers[participantId] = {
                animationId: requestAnimationFrame(animate),
                isMoving: isMoving
            };
        } else {
            // アニメーション完了後
            // 移動が停止した場合のみ方向指示を削除（停止タイマーで管理）
            if (!isMoving && this.movementStopTimers[participantId]) {
                this.stopMovementAnimation(participantId);
            }
        }
    };
    
    this.movementTrackers[participantId] = {
        animationId: requestAnimationFrame(animate),
        isMoving: isMoving
    };
}

// 方向指示円の作成
createDirectionIndicator(participantId, position, bearing, color) {
    // 既存の指示円を削除
    if (this.directionIndicators[participantId]) {
        this.map.removeLayer(this.directionIndicators[participantId]);
    }
    
    // 矢印付き円のHTMLを作成（マーカーと完全な同心円）
    const arrowHtml = `
        <div style="
            position: relative;
            width: 90px;
            height: 90px;
        ">
            <!-- 外側の円（白色、2px、マーカーと同心円） -->
            <div style="
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 70px;
                height: 70px;
                border: 2px solid white;
                border-radius: 50%;
                opacity: 0.9;
                animation: pulseDirection 1.5s infinite;
                box-shadow: 0 0 10px rgba(0, 0, 0, 0.2);
                z-index: 1;
            "></div>
            
            <!-- 方向矢印（青色、円の縁に配置） -->
            <div style="
                position: absolute;
                top: 10px;
                left: 50%;
                transform: translateX(-50%) rotate(${bearing}deg);
                transform-origin: center 35px;
                z-index: 1000;
            ">
                <svg width="24" height="24" viewBox="0 0 24 24" style="
                    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
                ">
                    <path d="M12 2 L20 12 L12 9 L4 12 Z" 
                          fill="#007bff" 
                          opacity="1"
                          stroke="white"
                          stroke-width="1.5"/>
                </svg>
            </div>
        </div>
        
        <style>
            @keyframes pulseDirection {
                0%, 100% { 
                    transform: translate(-50%, -50%) scale(1);
                    opacity: 0.9;
                }
                50% { 
                    transform: translate(-50%, -50%) scale(1.05);
                    opacity: 1;
                }
            }
        </style>
    `;
    
    const directionIcon = L.divIcon({
        html: arrowHtml,
        className: 'direction-indicator',
        iconSize: [90, 90],
        iconAnchor: [45, 65]  // マーカーの円形部分の中心に合わせる（マーカーは40x40でアンカーが[20,45]なので、円の中心は上から20px）
    });
    
    this.directionIndicators[participantId] = L.marker(position, {
        icon: directionIcon,
        interactive: false,
        zIndexOffset: 500 // マーカーより上に表示
    }).addTo(this.map);
}

// 移動アニメーション停止
stopMovementAnimation(participantId) {
    // アニメーション停止
    if (this.movementTrackers[participantId]) {
        if (this.movementTrackers[participantId].animationId) {
            cancelAnimationFrame(this.movementTrackers[participantId].animationId);
        }
        delete this.movementTrackers[participantId];
    }
    // 停止タイマーもクリア
    this.clearMovementStopTimer(participantId);
}
    
createPopupContent(location, name, color, stayMinutes, isBackground, isInCluster = false, clusterSize = 1, movementSpeed = 0, speedReliable = false) {
    const popupDiv = document.createElement('div');
    
    const nameDiv = document.createElement('div');
    nameDiv.style.color = color;
    nameDiv.style.fontWeight = 'bold';
    
    if (location.isOffline || !location.is_online || location.status === 'stopped') {
        nameDiv.innerHTML = `${name} <span style="color: #dc3545; font-size: 12px;">[オフライン]</span>`;
    } else {
        nameDiv.textContent = name;
    }
    popupDiv.appendChild(nameDiv);

    // クラスター情報を表示（オンライン時のみ）
    if (isInCluster && clusterSize > 1 && location.is_online) {
        const clusterDiv = document.createElement('div');
        clusterDiv.style.color = '#dc3545';
        clusterDiv.style.fontWeight = 'bold';
        clusterDiv.style.fontSize = '12px';
        clusterDiv.innerHTML = `<i class="fas fa-users"></i> ${clusterSize}人が近くにいます`;
        popupDiv.appendChild(clusterDiv);
    }
    
    // 最終更新時刻の表示
    const timeDiv = document.createElement('div');
    if (location.isOffline || !location.is_online || location.status === 'stopped') {
        const lastSeenTime = location.last_seen_at || location.last_updated;
        if (lastSeenTime) {
            const lastSeenDate = new Date(lastSeenTime);
            const now = new Date();
            const diffMinutes = Math.floor((now - lastSeenDate) / (1000 * 60));
            
            if (diffMinutes < 60) {
                timeDiv.innerHTML = `<span style="color: #dc3545;">最終確認: ${diffMinutes}分前</span>`;
            } else if (diffMinutes < 1440) {
                const diffHours = Math.floor(diffMinutes / 60);
                timeDiv.innerHTML = `<span style="color: #dc3545;">最終確認: ${diffHours}時間前</span>`;
            } else {
                const diffDays = Math.floor(diffMinutes / 1440);
                timeDiv.innerHTML = `<span style="color: #dc3545;">最終確認: ${diffDays}日前</span>`;
            }
        } else {
            timeDiv.innerHTML = `<span style="color: #dc3545;">最終確認: 不明</span>`;
        }
    } else {
        timeDiv.textContent = `最終更新: ${new Date(location.last_updated).toLocaleTimeString()}`;
    }
    popupDiv.appendChild(timeDiv);
    
    // 精度情報の表示
    const accuracyDiv = document.createElement('div');
    let accuracyText = '';
    
    if (location.isOffline || !location.is_online || location.status === 'stopped') {
        accuracyText = 'オフライン（最後の位置）';
        accuracyDiv.style.color = '#dc3545';
        accuracyDiv.style.fontStyle = 'italic';
    } else if (location.status === 'waiting') {
        accuracyText = location.participant_id === state.participantId ? '位置共有を開始してください' : '位置共有待ち';
    } else if (!location.accuracy || location.accuracy <= 0) {
        accuracyText = '精度: 不明';
    } else if (location.accuracy > 1000) {
        accuracyText = '精度: 低精度';
    } else {
        accuracyText = `精度: ${Math.round(location.accuracy)}m`;
    }
    
    accuracyDiv.textContent = accuracyText;
    popupDiv.appendChild(accuracyDiv);
    
    // 移動速度または滞在時間の表示（10km/h以上の場合のみ速度表示）
    if (!location.isOffline && location.is_online && !isBackground) {
        // 10km/h以上の場合は移動速度を表示
        if (movementSpeed >= 10) {
            const speedDiv = document.createElement('div');
            speedDiv.style.color = '#2196F3';
            speedDiv.style.fontWeight = 'bold';
            
            let speedText = '';
            let speedIcon = '';
            
            if (movementSpeed >= 20) {
                speedIcon = '🚗';
                speedText = `${speedIcon} ${Math.round(movementSpeed)}km/h`;
            } else {
                speedIcon = '🏃';
                speedText = `${speedIcon} ${Math.round(movementSpeed)}km/h`;
            }
            
            // 信頼性が低い場合は「約」を追加
            if (!speedReliable && movementSpeed < 15) {
                speedText = `${speedIcon} 約${Math.round(movementSpeed)}km/h`;
            }
            
            speedDiv.textContent = speedText;
            popupDiv.appendChild(speedDiv);
        }
        // 移動していない場合は滞在時間を表示
        else if (stayMinutes >= 1) {
            const stayDiv = document.createElement('div');
            stayDiv.style.color = '#ff9800';
            stayDiv.style.fontWeight = 'bold';
            stayDiv.textContent = `${stayMinutes}分滞在中`;
            popupDiv.appendChild(stayDiv);
        }
    }
    
    // バックグラウンド状態表示
    if (isBackground && location.is_online && !location.isOffline) {
        const backgroundDiv = document.createElement('div');
        backgroundDiv.style.color = '#6c757d';
        backgroundDiv.style.fontStyle = 'italic';
        backgroundDiv.innerHTML = '<i class="fas fa-mobile-alt"></i> バックグラウンド';
        popupDiv.appendChild(backgroundDiv);
    }

    // Google Mapsで案内ボタン（既存のまま）
    if (location.latitude !== null && location.longitude !== null && 
        location.latitude !== 999.0 && location.longitude !== 999.0 &&
        !isNaN(location.latitude) && !isNaN(location.longitude)) {
        
        const spacerDiv = document.createElement('div');
        spacerDiv.style.marginTop = '10px';
        spacerDiv.style.marginBottom = '5px';
        spacerDiv.style.borderTop = '1px solid #eee';
        popupDiv.appendChild(spacerDiv);
        
        const navigationButton = document.createElement('button');
        navigationButton.className = 'btn btn-primary btn-sm';
        navigationButton.style.cssText = `
            width: 100%;
            margin-bottom: 5px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            font-size: 13px;
            padding: 6px 12px;
            border-radius: 6px;
            transition: all 0.2s ease;
        `;
        
        navigationButton.innerHTML = '<i class="fas fa-route"></i> Google Mapsで案内';
        
        navigationButton.onclick = () => {
            this.openGoogleMapsNavigation(location);
        };
        
        navigationButton.onmouseenter = () => {
            navigationButton.style.transform = 'scale(1.02)';
            navigationButton.style.boxShadow = '0 4px 12px rgba(0,123,255,0.3)';
        };
        
        navigationButton.onmouseleave = () => {
            navigationButton.style.transform = 'scale(1)';
            navigationButton.style.boxShadow = 'none';
        };
        
        popupDiv.appendChild(navigationButton);
    }
    
    return popupDiv;
}

// ★ ：Google Maps案内を開くメソッド
openGoogleMapsNavigation(location) {
    const lat = location.latitude;
    const lng = location.longitude;
    const name = (location.participant_name || `参加者${location.participant_id.substring(0, 4)}`).substring(0, 50);
    
    // Google Maps URLを構築
    const destination = `${lat},${lng}`;
    const label = encodeURIComponent(name);
    
    // モバイルデバイスかどうかを判定
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    
    let mapsUrl;
    
    if (isMobile) {
        // モバイルの場合：Google Mapsアプリを優先
        mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${destination}&destination_place_id=&travelmode=walking`;
    } else {
        // デスクトップの場合：ブラウザ版Google Maps
        mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=walking`;
    }
    
    // 新しいタブ/ウィンドウで開く
    const opened = window.open(mapsUrl, '_blank', 'noopener,noreferrer');
    
    if (opened) {
        // ポップアップを閉じる
        this.map.closePopup();
    } 
}
    
    // createCustomMarkerメソッドを修正（クラスター情報を追加）
createCustomMarker(name, color, isBackground = false, stayMinutes = 0, isInCluster = false, clusterSize = 1, clusterIndex = 0, isOffline = false, movementSpeed = 0, speedReliable = false) {
    const initials = this.getInitials(name);
    
    // オフライン時のスタイル設定
    let offlineStyle = '';
    let offlineIndicator = '';
    let offlineAnimation = '';
    
    if (isOffline) {
        offlineStyle = `
            background: linear-gradient(135deg, #6c757d, #495057);
            border: 3px solid #adb5bd;
            opacity: 0.75;
            filter: grayscale(50%);
            position: relative;
        `;
        
        offlineIndicator = `
            <div style="
                position: absolute;
                top: -25px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(220, 53, 69, 0.9);
                color: white;
                font-size: 10px;
                padding: 2px 6px;
                border-radius: 8px;
                white-space: nowrap;
                font-weight: 500;
                border: 1px solid rgba(255, 255, 255, 0.3);
                box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                z-index: 1000;
            ">📴 オフライン</div>
        `;
        
        offlineAnimation = `animation: offlineFade 5s infinite ease-in-out;`;
    } else {
        // オンライン時のスタイル
        let clusterStyle = '';
        let clusterAnimation = '';
        
        if (isInCluster && clusterSize > 1) {
            const hueRotation = (clusterIndex * 60) % 360;
            clusterStyle = `
                background: linear-gradient(45deg, ${color}, ${this.lightenColor(color, 20)});
                border: 3px solid transparent;
                background-clip: padding-box;
                box-shadow: 
                    0 0 20px rgba(${this.hexToRgb(color)}, 0.6),
                    inset 0 0 20px rgba(255, 255, 255, 0.1);
                position: relative;
                overflow: visible;
            `;
            
            clusterAnimation = `
                animation: clusterGlow 2s infinite alternate, clusterFloat 3s infinite ease-in-out;
            `;
        } else {
            offlineStyle = `
                background-color: ${color};
                position: relative;
            `;
        }
        
        offlineStyle = clusterStyle || `background-color: ${color}; position: relative;`;
        offlineAnimation = clusterAnimation;
    }

    // バックグラウンド表示
    let backgroundIndicator = '';
    if (isBackground && !isOffline) {
        backgroundIndicator = `
            <div style="
                position: absolute;
                top: -25px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(108, 117, 125, 0.9);
                color: white;
                font-size: 10px;
                padding: 2px 6px;
                border-radius: 8px;
                white-space: nowrap;
                font-weight: 500;
                border: 1px solid rgba(255, 255, 255, 0.3);
                box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                z-index: 1000;
            ">バックグラウンド</div>
        `;
    }
    
    // ★ 修正：3km/h以上で速度表示
    let statusIndicator = '';
    if (!isBackground && !isOffline) {
        // 3km/h以上の場合のみ速度を表示
        if (movementSpeed >= 3) {
            let speedIcon = '🚶';  // ★ 歩行アイコン
            let bgGradient = 'linear-gradient(135deg, #4CAF50 0%, #66BB6A 100%)';  // ★ 緑系
            let displaySpeed = Math.round(movementSpeed);
            
            // ★ 速度に応じたアイコンと色の変更
            if (movementSpeed >= 20) {
                speedIcon = '🚗';
                bgGradient = 'linear-gradient(135deg, #FF5722 0%, #FF7043 100%)';
            } else if (movementSpeed >= 10) {
                speedIcon = '🏃';
                bgGradient = 'linear-gradient(135deg, #FF9800 0%, #FFB74D 100%)';
            } else if (movementSpeed >= 6) {
                speedIcon = '🏃‍♂️';  // ジョギング
                bgGradient = 'linear-gradient(135deg, #FFC107 0%, #FFD54F 100%)';
            }
            
            // 信頼性が低い場合の表示調整
            const speedText = (!speedReliable && movementSpeed < 5) ? 
                `約${displaySpeed}km/h` : `${displaySpeed}km/h`;
            
            statusIndicator = `
                <div style="
                    position: absolute;
                    top: -30px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: ${bgGradient};
                    color: white;
                    font-size: 10px;
                    padding: 4px 8px;
                    border-radius: 12px;
                    white-space: nowrap;
                    font-weight: 600;
                    border: 1px solid rgba(255, 255, 255, 0.3);
                    box-shadow: 0 4px 15px rgba(0,0,0,0.2);
                    z-index: 1001;
                    backdrop-filter: blur(10px);
                    animation: speedPulse 1.5s infinite ease-in-out;
                ">${speedIcon} ${speedText}</div>
            `;
        }
        // 移動していない場合は滞在時間を表示
        else if (stayMinutes >= 1) {
            statusIndicator = `
                <div style="
                    position: absolute;
                    top: -30px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: linear-gradient(135deg, #ff9a9e 0%, #fecfef 50%, #fecfef 100%);
                    color: #333;
                    font-size: 10px;
                    padding: 4px 8px;
                    border-radius: 12px;
                    white-space: nowrap;
                    font-weight: 600;
                    border: 1px solid rgba(255, 255, 255, 0.3);
                    box-shadow: 0 4px 15px rgba(0,0,0,0.2);
                    z-index: 1001;
                    backdrop-filter: blur(10px);
                    animation: stayTimePulse 2s infinite ease-in-out;
                ">⏰ ${stayMinutes}分滞在</div>
            `;
        }
    }

    // 以下既存のコード（クラスター情報、キラキラエフェクトなど）はそのまま
    let clusterIndicator = '';
    if (isInCluster && clusterSize > 1) {
        const badgeBackground = isOffline ? 
            'linear-gradient(135deg, #6c757d, #495057)' : 
            'linear-gradient(135deg, #ff6b6b, #ee5a52)';
        
        const badgeOpacity = isOffline ? '0.8' : '1';
        
        clusterIndicator = `
        <div style="
            position: absolute;
            top: -8px;
            right: -8px;
            background: ${badgeBackground};
            color: white;
            font-size: 10px;
            padding: 0;
            width: 24px;
            height: 24px;
            border-radius: 50%;
            font-weight: bold;
            display: flex;
            align-items: center;
            justify-content: center;
            border: 2px solid white;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
            z-index: 1002;
            opacity: ${badgeOpacity};
            animation: ${isOffline ? 'none' : 'bounce 1s infinite'};
        ">
            👥${clusterSize}
        </div>
        `;
    }

    let sparkleEffect = '';
    if (isInCluster && !isOffline) {
        sparkleEffect = `
            <div class="sparkle-container" style="
                position: absolute;
                top: -5px;
                left: -5px;
                right: -5px;
                bottom: -5px;
                pointer-events: none;
                z-index: 999;
            ">
                <div class="sparkle" style="position: absolute; top: 10%; left: 20%; animation: sparkle 1.5s infinite;">✨</div>
                <div class="sparkle" style="position: absolute; top: 70%; right: 10%; animation: sparkle 1.8s infinite 0.3s;">⭐</div>
                <div class="sparkle" style="position: absolute; bottom: 20%; left: 60%; animation: sparkle 1.2s infinite 0.6s;">💫</div>
            </div>
        `;
    }
    
    const markerHtml = `
<div class="custom-marker ${isOffline ? 'offline-marker' : ''}" style="
    ${offlineStyle}
    ${offlineAnimation}
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    transform-style: preserve-3d;
">
    ${initials}
    ${offlineIndicator}
    ${backgroundIndicator}
    ${statusIndicator}
    ${clusterIndicator}
    ${sparkleEffect}
</div>
<style>
    @keyframes speedPulse {
        0%, 100% { 
            transform: translateX(-50%) scale(1);
            opacity: 0.95;
        }
        50% { 
            transform: translateX(-50%) scale(1.05);
            opacity: 1;
        }
    }
    
    @keyframes offlineFade {
        0%, 100% { 
            opacity: 0.6;
        }
        50% { 
            opacity: 0;
        }
    }
    
    @keyframes stayTimePulse {
        0%, 100% { 
            transform: translateX(-50%) scale(1);
            opacity: 0.9;
        }
        50% { 
            transform: translateX(-50%) scale(1.05);
            opacity: 1;
        }
    }
    
    @keyframes clusterGlow {
        0% { box-shadow: 0 0 20px rgba(${this.hexToRgb(color)}, 0.6), inset 0 0 20px rgba(255, 255, 255, 0.1); }
        100% { box-shadow: 0 0 30px rgba(${this.hexToRgb(color)}, 0.9), inset 0 0 25px rgba(255, 255, 255, 0.2); }
    }
    @keyframes clusterFloat {
        0%, 100% { transform: translateY(0px) rotateZ(0deg); }
        50% { transform: translateY(-5px) rotateZ(2deg); }
    }
    @keyframes bounce {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.1); }
    }
    @keyframes sparkle {
        0%, 100% { opacity: 0; transform: scale(0.5) rotate(0deg); }
        50% { opacity: 1; transform: scale(1) rotate(180deg); }
    }
</style>
`;
    
    return L.divIcon({
        html: markerHtml,
        className: 'custom-div-icon',
        iconSize: [40, 40],
        iconAnchor: [20, 45],
        popupAnchor: [0, -40]
    });
}
    // 色を明るくするヘルパー関数
    lightenColor(hex, percent) {
        const num = parseInt(hex.replace("#", ""), 16);
        const amt = Math.round(2.55 * percent);
        const R = (num >> 16) + amt;
        const G = (num >> 8 & 0x00FF) + amt;
        const B = (num & 0x0000FF) + amt;
        return "#" + (0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 +
            (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 +
            (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1);
    }

    // HEXをRGBに変換
    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? 
            `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : 
            '255, 107, 107';
    }
    
    getInitials(name) {
        if (!name) return 'UN';
        const limitedName = name.substring(0, 30);
        return limitedName.substring(0, 2).toUpperCase();
    }
    
    getParticipantColor(participantId) {
        if (!state.participantColors[participantId]) {
            state.participantColors[participantId] = this.getDeterministicColor(participantId);
        }
        return state.participantColors[participantId];
    }
    
    getDeterministicColor(participantId) {
        let hash = 0;
        for (let i = 0; i < participantId.length; i++) {
            const char = participantId.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        
    const colors = [
        '#FF6B6B', // 赤
        '#4ECDC4', // ターコイズ
        '#45B7D1', // スカイブルー
        '#96CEB4', // ミントグリーン
        '#FFEAA7', // 淡い黄色
        '#DDA0DD', // プラム
        '#FFB6C1', // ライトピンク
        '#20B2AA', // ライトシーグリーン
        '#FF69B4', // ホットピンク
        '#32CD32', // ライムグリーン
        '#FF4500', // オレンジレッド
        '#8A2BE2', // ブルーバイオレット
        '#DC143C', // クリムゾン
        '#00CED1', // ダークターコイズ
        '#FFD700', // ゴールド
        '#FF1493', // ディープピンク
        '#00FA9A', // ミディアムスプリンググリーン
        '#1E90FF', // ドジャーブルー
        '#FF8C00', // ダークオレンジ
        '#9370DB', // ミディアムパープル
        '#3CB371', // ミディアムシーグリーン
        '#BA55D3', // ミディアムオーキッド
        '#FF6347', // トマト
        '#4682B4', // スチールブルー
        '#D2691E', // チョコレート
        '#6A5ACD', // スレートブルー
        '#FF7F50', // コーラル
        '#40E0D0', // ターコイズ
        '#EE82EE', // バイオレット
        '#F0E68C', // カーキ
        '#B22222', // ファイアブリック
        '#5F9EA0', // ケイディットブルー
        '#FF00FF', // マゼンタ
        '#00FF7F', // スプリンググリーン
        '#FFA500', // オレンジ
        '#4169E1', // ロイヤルブルー
        '#FA8072', // サーモン
        '#00BFFF', // ディープスカイブルー
        '#F4A460', // サンディブラウン
        '#9932CC', // ダークオーキッド
        '#FF00BF', // 明るいマゼンタ
        '#2E8B57', // シーグリーン
        '#FF5FA2', // ネオンピンク
        '#00D9FF', // ネオンブルー
        '#B8FF00', // ライムイエロー
        '#FF3E96', // マゼンタピンク
        '#00E5FF', // シアン
        '#FFE600', // イエロー
        '#6B00FF', // パープル
        '#FF9E00'  // アンバー
    ];
        
        return colors[Math.abs(hash) % colors.length];
    }
    
    updateAccuracyCircle(participantId, latitude, longitude, accuracy, color) {
    if (!accuracy || accuracy <= 0 || accuracy > 1000) {
        if (this.accuracyCircles[participantId]) {
            this.map.removeLayer(this.accuracyCircles[participantId]);
            delete this.accuracyCircles[participantId];
        }
        return;
    }

    const position = [latitude, longitude];
    
    if (this.accuracyCircles[participantId]) {
        this.accuracyCircles[participantId].setLatLng(position);
        this.accuracyCircles[participantId].setRadius(accuracy);
        
        // ★ 修正：既存の円にもpointer-events無効化を適用
        if (this.accuracyCircles[participantId]._path) {
            this.accuracyCircles[participantId]._path.style.pointerEvents = 'none';
            this.accuracyCircles[participantId]._path.style.zIndex = '-1';
        }
    } else {
        this.accuracyCircles[participantId] = L.circle(position, {
            radius: accuracy,
            color: color,
            fillColor: color,
            fillOpacity: 0.1,
            opacity: 0.3,
            weight: 2,
            // ★ 修正：精度円もマップ操作をブロックしないよう設定
            interactive: false,
            bubblingMouseEvents: false,
            pane: 'overlayPane' // マーカーより下のレイヤーに配置
        }).addTo(this.map);
        
        // ★ 修正：DOMレベルでもpointer-eventsを無効化
        if (this.accuracyCircles[participantId]._path) {
            this.accuracyCircles[participantId]._path.style.pointerEvents = 'none';
            this.accuracyCircles[participantId]._path.style.zIndex = '-1';
        }
    }
}
    
    createRippleAnimation(participantId, latitude, longitude, color, accuracy) {
    if (this.animationCircles[participantId]) {
        this.map.removeLayer(this.animationCircles[participantId]);
        delete this.animationCircles[participantId];
    }
    
    let maxRadius = (!accuracy || accuracy <= 0 || accuracy > 1000) ? 50 : accuracy;
    
    const animationCircle = L.circle([latitude, longitude], {
        radius: 8,
        color: color,
        fillColor: color,
        fillOpacity: 0.3,
        opacity: 0.8,
        weight: 3,
        // ★ 修正：マップ操作をブロックしないよう設定
        interactive: false,
        bubblingMouseEvents: false,
        pane: 'overlayPane' // マーカーより下のレイヤーに配置
    }).addTo(this.map);
    
    // ★ 修正：DOMレベルでもpointer-eventsを無効化
    if (animationCircle._path) {
        animationCircle._path.style.pointerEvents = 'none';
        animationCircle._path.style.zIndex = '-1';
    }
    
    this.animationCircles[participantId] = animationCircle;
    
    const duration = 1500;
    const startTime = Date.now();
    const initialRadius = 8;
    
    const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = elapsed / duration;
        
        if (progress >= 1) {
            animationCircle.setRadius(maxRadius);
            animationCircle.setStyle({
                opacity: 0.2,
                fillOpacity: 0.05,
                weight: 2
            });
            
            // ★ 修正：アニメーション完了後もpointer-eventsを無効のまま
            if (animationCircle._path) {
                animationCircle._path.style.pointerEvents = 'none';
                animationCircle._path.style.zIndex = '-1';
            }
            return;
        }
        
        const easeOut = 1 - Math.pow(1 - progress, 3);
        const currentRadius = initialRadius + (maxRadius - initialRadius) * easeOut;
        const currentOpacity = 0.8 * (1 - progress * 0.75);
        const currentFillOpacity = 0.3 * (1 - progress * 0.83);
        
        animationCircle.setRadius(currentRadius);
        animationCircle.setStyle({
            opacity: currentOpacity,
            fillOpacity: currentFillOpacity,
            weight: Math.max(2, 3 * (1 - progress * 0.33))
        });
        
        // ★ 修正：アニメーション中も継続的にpointer-eventsを無効化
        if (animationCircle._path) {
            animationCircle._path.style.pointerEvents = 'none';
            animationCircle._path.style.zIndex = '-1';
        }
        
        requestAnimationFrame(animate);
    };
    
    requestAnimationFrame(animate);
}
    
startRegularAnimation(participantId, latitude, longitude, color, accuracy) {
    // ★ 3秒ごとの定期更新を削除
    // 既存のインターバルがあればクリアのみ行う
    if (this.regularAnimationIntervals[participantId]) {
        clearInterval(this.regularAnimationIntervals[participantId]);
        delete this.regularAnimationIntervals[participantId];
    }
    // インターバルの新規設定は行わない
}
    
    stopRegularAnimation(participantId) {
        if (this.regularAnimationIntervals[participantId]) {
            clearInterval(this.regularAnimationIntervals[participantId]);
            delete this.regularAnimationIntervals[participantId];
        }
    }
    
resetAutoFit() {
    state.userInteracted = false;
    state.autoFitEnabled = true;
    state.followingParticipantId = null;
    
    // グループ追従も確実に解除
    if (state.followingGroup) {
        state.followingGroup = null;
        this.stopGroupFollowingTimer();
    }
    
    
    const allLayers = [...Object.values(this.markers), ...Object.values(this.accuracyCircles)];
    
    if (allLayers.length > 0) {
        if (Object.keys(this.markers).length === 1) {
            const marker = Object.values(this.markers)[0];
            const latLng = marker.getLatLng();
            this.map.setView([latLng.lat, latLng.lng], 15);
        } else {
            const group = new L.featureGroup(allLayers);
            const bounds = group.getBounds();
            if (bounds.isValid()) {
                this.map.fitBounds(bounds.pad(0.1));
            }
        }
    }
}

updateSingleMarkerOnly(location) { 
    if (!this.mapInitialized) {
        console.warn('マップが初期化されていません');
        return;
    }
    
    // 有効な座標かチェック
    const hasValidCoords = location.latitude !== null && 
                          location.longitude !== null && 
                          location.latitude !== 999.0 && 
                          location.longitude !== 999.0 &&
                          !isNaN(location.latitude) && 
                          !isNaN(location.longitude);
    
    if (!hasValidCoords) {
        this.removeMarker(location.participant_id);
        return;
    }
    
    // ★重要：現在のクラスタ情報を取得して保持
    const clusterInfo = this.getCurrentClusterInfo(location.participant_id);
    
    // オフライン状態の判定
    const isOffline = location.is_online === false || location.status === 'stopped';
    
    // マーカーデータを準備（クラスタ情報を含める）
    const markerLocation = {
        ...location,
        isOffline: isOffline,
        isInCluster: clusterInfo ? true : false,
        clusterSize: clusterInfo ? clusterInfo.participants.length : 1
    };
    
    // マーカーを更新
    this.updateSingleMarker(markerLocation);
    
}
}

// === 参加者管理クラス ===
class ParticipantManager {
    updateList(locations) {
    if (!ui.elements.participantsList) return;
    
    // ★ 修正：自分が退出中の場合は参加者リスト更新をスキップ
    if (state.isLeaving) {
        return;
    }
    
    
    if (locations.length === 0) {
        const emptyHtml = '<div class="text-center text-muted">参加者がいません</div>';
        if (ui.currentParticipantsHtml !== emptyHtml) {
            ui.elements.participantsList.innerHTML = emptyHtml;
            ui.currentParticipantsHtml = emptyHtml;
        }
        return;
    }
    
    // ★ 修正：自分を除外した参加者リストを作成（退出中の場合）
    const filteredLocations = state.isLeaving ? 
        locations.filter(location => location.participant_id !== state.participantId) : 
        locations;
    
    // 重複参加者を処理
    const processedLocations = this.removeDuplicateParticipants(filteredLocations);
    
    // 新規参加者を順序リストに追加
    processedLocations.forEach(location => {
        if (!state.participantOrder.includes(location.participant_id)) {
            state.participantOrder.push(location.participant_id);
        }
    });
    
    // 退出した参加者を順序リストから削除
    state.participantOrder = state.participantOrder.filter(id => 
        processedLocations.some(location => location.participant_id === id)
    );
    
    state.participantsData = processedLocations;
    this.updateDisplay();
}
    // === ：重複参加者を除去するメソッド ===
    removeDuplicateParticipants(locations) {
    const nameGroups = new Map();
    
    // 参加者名でグループ化
    locations.forEach(location => {
        const name = (location.participant_name || '').trim().toLowerCase();
        if (!name) return; // 名前が空の場合はスキップ
        
        if (!nameGroups.has(name)) {
            nameGroups.set(name, []);
        }
        nameGroups.get(name).push(location);
    });
    
    const processedLocations = [];
    const removedParticipantIds = [];
    
    // 各名前グループを処理
    nameGroups.forEach((group, name) => {
        if (group.length === 1) {
            // 重複なし
            processedLocations.push(group[0]);
        } else {
            // 重複あり - オンラインの参加者を優先
            
            // 自分が含まれている場合は自分を最優先
            const selfParticipant = group.find(p => p.participant_id === state.participantId);
            if (selfParticipant) {
                processedLocations.push(selfParticipant);
                group.filter(p => p.participant_id !== state.participantId)
                     .forEach(p => removedParticipantIds.push(p.participant_id));
            } else {
                // 自分以外の場合は、オンライン > 共有中 > 最新更新 の順で優先
                const sortedGroup = group.sort((a, b) => {
                    // オンライン状態で比較
                    if (a.is_online !== b.is_online) {
                        return b.is_online ? 1 : -1;
                    }
                    // 共有状態で比較
                    if (a.status !== b.status) {
                        return (b.status === 'sharing') ? 1 : -1;
                    }
                    // 最新更新時刻で比較
                    return new Date(b.last_updated) - new Date(a.last_updated);
                });
                
                // 最優先の参加者を採用
                processedLocations.push(sortedGroup[0]);
                sortedGroup.slice(1).forEach(p => removedParticipantIds.push(p.participant_id));
            }
        }
    });
    
    // 名前が空の参加者も追加（重複チェック対象外）
    locations.filter(location => !(location.participant_name || '').trim())
             .forEach(location => processedLocations.push(location));
    
    // 除去された参加者のマーカーとデータをクリーンアップ
    if (removedParticipantIds.length > 0) {
        this.cleanupRemovedParticipants(removedParticipantIds);
        
        // サーバーに削除通知を送信
        this.notifyServerOfRemovedDuplicates(removedParticipantIds);
        
        // ★ ：削除された参加者の通知を抑制
        this.suppressNotificationsForRemovedParticipants(removedParticipantIds);
    }
    
    return processedLocations;
}
// ★ ：削除された参加者の通知を抑制するメソッド
suppressNotificationsForRemovedParticipants(removedParticipantIds) {
    // 削除された参加者を前回状態からも除去（通知が表示されないようにする）
    removedParticipantIds.forEach(participantId => {
        if (state.previousParticipantsState.has(participantId)) {
            state.previousParticipantsState.delete(participantId);
        }
    });
    
    // 削除された参加者への参加通知も取り消し
    // if (removedParticipantIds.length > 0) {
    //     ui.showNotification(
    //         `${removedParticipantIds.length}人の重複参加者を整理しました`,
    //         'info',
    //         'fas fa-users-cog',
    //         false // サイレント通知（控えめに表示）
    //     );
    // }
}
    // === ★ ：サーバーに重複削除を通知 ===
notifyServerOfRemovedDuplicates(removedParticipantIds) {
    if (!wsManager.websocket || wsManager.websocket.readyState !== WebSocket.OPEN) {
        console.warn('WebSocket未接続のため重複削除通知をスキップ');
        return;
    }
    
    const duplicateRemovalData = {
        type: 'duplicate_participants_removed',
        removed_participant_ids: removedParticipantIds,
        reporter_participant_id: state.participantId,
        timestamp: new Date().toISOString(),
        session_id: state.sessionId,
        cleanup_request: true // サーバー側でも削除処理を要求
    };
    
    const sent = wsManager.send(duplicateRemovalData);
    if (sent) {
    } else {
        console.warn('重複削除通知の送信に失敗');
    }
}
    // === ：除去された参加者のクリーンアップ（強化版） ===
cleanupRemovedParticipants(removedParticipantIds) {
    removedParticipantIds.forEach(participantId => {
        
        // 1. マーカーとマップ要素を削除
        if (mapManager.markers[participantId]) {
            mapManager.removeMarker(participantId);
        }
        
        // 2. 参加者順序から削除
        const orderIndex = state.participantOrder.indexOf(participantId);
        if (orderIndex !== -1) {
            state.participantOrder.splice(orderIndex, 1);
        }
        
        // 3. 参加者色設定から削除
        if (state.participantColors[participantId]) {
            delete state.participantColors[participantId];
        }
        
        // 4. 以前の状態履歴から削除
        if (state.previousParticipantsState.has(participantId)) {
            state.previousParticipantsState.delete(participantId);
        }
        
        // 5. 追従設定から削除
        if (state.followingParticipantId === participantId) {
            state.followingParticipantId = null;
            mapManager.resetAutoFit();
        }
        
        // 6. グループ追従から除外
        if (state.followingGroup && state.followingGroup.includes(participantId)) {
            state.followingGroup = state.followingGroup.filter(id => id !== participantId);
            if (state.followingGroup.length === 0) {
                state.followingGroup = null;
                mapManager.stopGroupFollowingTimer();
            }
        }
        
        // 7. ★ participantsData から完全除去
        state.participantsData = state.participantsData.filter(p => p.participant_id !== participantId);
        
        // 8. ★ アニメーション関連のクリーンアップ
        if (mapManager.regularAnimationIntervals[participantId]) {
            clearInterval(mapManager.regularAnimationIntervals[participantId]);
            delete mapManager.regularAnimationIntervals[participantId];
        }
        
        // 9. ★ クラスター関連のクリーンアップ
        Object.keys(mapManager.clusterConnections).forEach(clusterId => {
            if (clusterId.includes(participantId)) {
                if (mapManager.clusterConnections[clusterId]) {
                    mapManager.map.removeLayer(mapManager.clusterConnections[clusterId]);
                }
                delete mapManager.clusterConnections[clusterId];
            }
        });
        
        // 10. ★ パルスアニメーションのクリーンアップ
        Object.keys(mapManager.pulseAnimations || {}).forEach(pulseId => {
            if (pulseId.includes(participantId)) {
                if (mapManager.pulseAnimations[pulseId].interval) {
                    clearInterval(mapManager.pulseAnimations[pulseId].interval);
                }
                if (mapManager.pulseAnimations[pulseId].circle) {
                    mapManager.map.removeLayer(mapManager.pulseAnimations[pulseId].circle);
                }
                delete mapManager.pulseAnimations[pulseId];
            }
        });
    });
    
    // ★ 状態を保存して永続化
    state.save();
    
}
    updateDisplay() {
        if (!ui.elements.participantsList || state.participantsData.length === 0) return;
        
        ui.elements.participantsList.innerHTML = '';
        
        const sortedLocations = state.participantOrder.map(id => 
            state.participantsData.find(location => location.participant_id === id)
        ).filter(location => location !== undefined);
        
        sortedLocations.forEach(location => {
            const participantDiv = this.createParticipantElement(location);
            ui.elements.participantsList.appendChild(participantDiv);
        });
    }
    
    // === 参加者管理クラス - createParticipantElement メソッドの修正 ===
createParticipantElement(location) {
    const isMe = location.participant_id === state.participantId;
    const isFollowing = state.followingParticipantId === location.participant_id;
    const lastUpdated = new Date(location.last_updated);
    const timeDiff = Math.floor((new Date() - lastUpdated) / 1000);
    
    const canShowFollowing = isFollowing && 
                           location.is_online && 
                           location.status === 'sharing' &&
                           location.latitude !== null && 
                           location.longitude !== null;
    
    const { statusClass, statusText } = this.getParticipantStatus(location, isMe, timeDiff);
    const color = mapManager.getParticipantColor(location.participant_id);
    const originalName = location.participant_name || `参加者${location.participant_id.substring(0, 4)}`;
    const name = originalName.substring(0, 30);
    
    const participantDiv = document.createElement('div');
    participantDiv.className = `participant-item ${canShowFollowing ? 'following-participant' : ''}`;
    
    const statusDot = document.createElement('div');
    statusDot.className = `status-dot ${statusClass}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'flex-grow-1';
    
    const nameStrong = document.createElement('strong');
    nameStrong.style.color = color;
    nameStrong.textContent = name;
    contentDiv.appendChild(nameStrong);
    
    if (isMe) {
        const selfBadge = document.createElement('span');
        selfBadge.className = 'badge bg-primary ms-1';
        selfBadge.textContent = '自分';
        contentDiv.appendChild(selfBadge);
    }
    
    if (canShowFollowing) {
        const followingBadge = document.createElement('span');
        followingBadge.className = 'badge bg-info ms-1';
        followingBadge.innerHTML = '<i class="fas fa-crosshairs"></i> 追従中';
        contentDiv.appendChild(followingBadge);
    }
    
    contentDiv.appendChild(document.createElement('br'));
    
    const statusSmall = document.createElement('small');
    statusSmall.className = 'text-muted';
    statusSmall.textContent = statusText;
    contentDiv.appendChild(statusSmall);
    
    // === 精度表示の追加 ===
    if (location.status === 'sharing' && location.is_online && 
        location.latitude !== null && location.longitude !== null) {
        
        contentDiv.appendChild(document.createElement('br'));
        
        const accuracySpan = document.createElement('small');
        accuracySpan.className = 'text-muted';
        
        let accuracyText = '';
        let accuracyClass = '';
        
        if (!location.accuracy || location.accuracy <= 0) {
            accuracyText = '精度: 不明';
            accuracyClass = 'text-secondary';
        } else if (location.accuracy <= 20) {
            accuracyText = `精度: ${Math.round(location.accuracy)}m (高精度)`;
            accuracyClass = 'text-success';
        } else if (location.accuracy <= 50) {
            accuracyText = `精度: ${Math.round(location.accuracy)}m (中精度)`;
            accuracyClass = 'text-warning';
        } else if (location.accuracy <= 200) {
            accuracyText = `精度: ${Math.round(location.accuracy)}m (低精度)`;
            accuracyClass = 'text-danger';
        } else {
            accuracyText = `精度: ${Math.round(location.accuracy)}m (非常に低い)`;
            accuracyClass = 'text-danger';
        }
        
        accuracySpan.innerHTML = `<i class="fas fa-bullseye me-1"></i>${accuracyText}`;
        accuracySpan.className = `${accuracyClass} fw-bold`;
        contentDiv.appendChild(accuracySpan);
        
        // 精度アイコンの色も変更
        const icon = accuracySpan.querySelector('i');
        if (icon) {
            icon.className = `fas fa-bullseye me-1 ${accuracyClass}`;
        }
    }
    
    participantDiv.appendChild(statusDot);
    participantDiv.appendChild(contentDiv);
    
    return participantDiv;
}    
    getParticipantStatus(location, isMe, timeDiff) {
    const hasValidLocation = location.latitude !== null && 
                           location.longitude !== null && 
                           location.latitude !== 999.0 && 
                           location.longitude !== 999.0 &&
                           !isNaN(location.latitude) && 
                           !isNaN(location.longitude);
    
    // ★ 修正：未共有（waiting）状態の判定を改善
    if (location.status === 'waiting' && location.is_online === true) {
        // ★ 最終更新からの経過時間をチェック
        const lastSeenTime = location.last_seen_at || location.last_updated;
        if (lastSeenTime) {
            const lastSeenDate = new Date(lastSeenTime);
            const now = new Date();
            const diffMinutes = Math.floor((now - lastSeenDate) / (1000 * 60));
            
            // ★ 5分以上更新がない場合は接続確認中と表示
            if (diffMinutes >= 5) {
                return {
                    statusClass: 'status-waiting',
                    statusText: isMe ? '接続確認中...' : `参加中（最終接続${diffMinutes}分前）`
                };
            }
        }
        
        return {
            statusClass: 'status-waiting',
            statusText: isMe ? '共有待機中' : '参加中（未共有）'
        };
    }
    
    // ★ 修正：オフライン判定を厳密化（waiting状態はオフラインにしない）
    if ((location.is_online === false || location.status === 'stopped') && location.status !== 'waiting') {
        // 最終確認時刻から経過時間を計算
        const lastSeenTime = location.last_seen_at || location.last_updated;
        let offlineText = 'オフライン';
        
        if (lastSeenTime) {
            const lastSeenDate = new Date(lastSeenTime);
            const now = new Date();
            const diffMinutes = Math.floor((now - lastSeenDate) / (1000 * 60));
            
            if (diffMinutes < 1) {
                offlineText = 'オフライン（今）';
            } else if (diffMinutes < 60) {
                offlineText = `オフライン (${diffMinutes}分前)`;
            } else if (diffMinutes < 1440) { // 24時間以内
                const diffHours = Math.floor(diffMinutes / 60);
                offlineText = `オフライン (${diffHours}時間前)`;
            } else {
                const diffDays = Math.floor(diffMinutes / 1440);
                offlineText = `オフライン (${diffDays}日前)`;
            }
        }
        
        return {
            statusClass: 'status-offline',
            statusText: offlineText
        };
    }
    

    if (location.status === 'sharing' && hasValidLocation && location.is_online === true) {
        if (location.is_background || timeDiff > 120) {
            return {
                statusClass: 'status-background',
                statusText: 'バックグラウンド'
            };
        } else {
            return {
                statusClass: 'status-online',
                statusText: 'オンライン'
            };
        }
    } else {
        return {
            statusClass: 'status-waiting',
            statusText: isMe ? '状態確認中' : '状態不明'
        };
    }
}
// ★ ：外部から呼び出し可能な重複処理メソッド
processLocationsForDuplicates(locations) {
    // 退出中の場合は自分を除外
    const filteredLocations = state.isLeaving ? 
        locations.filter(location => location.participant_id !== state.participantId) : 
        locations;
    
    // 重複参加者を処理
    return this.removeDuplicateParticipants(filteredLocations);
}

// ★ ：処理済みデータでリストを更新するメソッド
updateListAfterProcessing(processedLocations) {
    if (!ui.elements.participantsList) return;
    
    if (processedLocations.length === 0) {
        const emptyHtml = '<div class="text-center text-muted">参加者がいません</div>';
        if (ui.currentParticipantsHtml !== emptyHtml) {
            ui.elements.participantsList.innerHTML = emptyHtml;
            ui.currentParticipantsHtml = emptyHtml;
        }
        return;
    }
    
    // 新規参加者を順序リストに追加
    processedLocations.forEach(location => {
        if (!state.participantOrder.includes(location.participant_id)) {
            state.participantOrder.push(location.participant_id);
        }
    });
    
    // 退出した参加者を順序リストから削除
    state.participantOrder = state.participantOrder.filter(id => 
        processedLocations.some(location => location.participant_id === id)
    );
    
    state.participantsData = processedLocations;
    this.updateDisplay();
}

updateSingleParticipant(participantData) {
    console.log('=== 単一参加者リスト更新 ===');
    
    if (!ui.elements.participantsList) return;
    
    // 既存の参加者要素を検索（セレクタを使用）
    const existingElement = ui.elements.participantsList.querySelector(
        `[data-participant-id="${participantData.participant_id}"]`
    );
    
    if (existingElement) {
        // 既存要素を置き換え
        const newElement = this.createParticipantElement(participantData);
        newElement.dataset.participantId = participantData.participant_id;
        existingElement.replaceWith(newElement);
    } else {
        // 新規参加者の場合は追加
        const newElement = this.createParticipantElement(participantData);
        newElement.dataset.participantId = participantData.participant_id;
        ui.elements.participantsList.appendChild(newElement);
    }
}

createParticipantElement(location) {
    const isMe = location.participant_id === state.participantId;
    const isFollowing = state.followingParticipantId === location.participant_id;
    const lastUpdated = new Date(location.last_updated);
    const timeDiff = Math.floor((new Date() - lastUpdated) / 1000);
    
    const canShowFollowing = isFollowing && 
                           location.is_online && 
                           location.status === 'sharing' &&
                           location.latitude !== null && 
                           location.longitude !== null;
    
    const { statusClass, statusText } = this.getParticipantStatus(location, isMe, timeDiff);
    const color = mapManager.getParticipantColor(location.participant_id);
    const originalName = location.participant_name || `参加者${location.participant_id.substring(0, 4)}`;
    const name = originalName.substring(0, 30);
    
    const participantDiv = document.createElement('div');
    participantDiv.className = `participant-item ${canShowFollowing ? 'following-participant' : ''}`;
    
    // ★ 重要：data-participant-id属性を設定
    participantDiv.dataset.participantId = location.participant_id;
    
    const statusDot = document.createElement('div');
    statusDot.className = `status-dot ${statusClass}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'flex-grow-1';
    
    const nameStrong = document.createElement('strong');
    nameStrong.style.color = color;
    nameStrong.textContent = name;
    contentDiv.appendChild(nameStrong);
    
    if (isMe) {
        const selfBadge = document.createElement('span');
        selfBadge.className = 'badge bg-primary ms-1';
        selfBadge.textContent = '自分';
        contentDiv.appendChild(selfBadge);
    }
    
    if (canShowFollowing) {
        const followingBadge = document.createElement('span');
        followingBadge.className = 'badge bg-info ms-1';
        followingBadge.innerHTML = '<i class="fas fa-crosshairs"></i> 追従中';
        contentDiv.appendChild(followingBadge);
    }
    
    contentDiv.appendChild(document.createElement('br'));
    
    const statusSmall = document.createElement('small');
    statusSmall.className = 'text-muted';
    statusSmall.textContent = statusText;
    contentDiv.appendChild(statusSmall);
    
    // 精度表示の追加
    if (location.status === 'sharing' && location.is_online && 
        location.latitude !== null && location.longitude !== null) {
        
        contentDiv.appendChild(document.createElement('br'));
        
        const accuracySpan = document.createElement('small');
        accuracySpan.className = 'text-muted';
        
        let accuracyText = '';
        let accuracyClass = '';
        
        if (!location.accuracy || location.accuracy <= 0) {
            accuracyText = '精度: 不明';
            accuracyClass = 'text-secondary';
        } else if (location.accuracy <= 20) {
            accuracyText = `精度: ${Math.round(location.accuracy)}m (高精度)`;
            accuracyClass = 'text-success';
        } else if (location.accuracy <= 50) {
            accuracyText = `精度: ${Math.round(location.accuracy)}m (中精度)`;
            accuracyClass = 'text-warning';
        } else if (location.accuracy <= 200) {
            accuracyText = `精度: ${Math.round(location.accuracy)}m (低精度)`;
            accuracyClass = 'text-danger';
        } else {
            accuracyText = `精度: ${Math.round(location.accuracy)}m (非常に低い)`;
            accuracyClass = 'text-danger';
        }
        
        accuracySpan.innerHTML = `<i class="fas fa-bullseye me-1"></i>${accuracyText}`;
        accuracySpan.className = `${accuracyClass} fw-bold`;
        contentDiv.appendChild(accuracySpan);
        
        const icon = accuracySpan.querySelector('i');
        if (icon) {
            icon.className = `fas fa-bullseye me-1 ${accuracyClass}`;
        }
    }
    
    participantDiv.appendChild(statusDot);
    participantDiv.appendChild(contentDiv);
    
    return participantDiv;
}

updateDisplay() {
    if (!ui.elements.participantsList || state.participantsData.length === 0) return;
    
    ui.elements.participantsList.innerHTML = '';
    
    const sortedLocations = state.participantOrder.map(id => 
        state.participantsData.find(location => location.participant_id === id)
    ).filter(location => location !== undefined);
    
    sortedLocations.forEach(location => {
        const participantDiv = this.createParticipantElement(location);
        // ★ 重要：ここでもdata-participant-id属性を設定
        participantDiv.dataset.participantId = location.participant_id;
        ui.elements.participantsList.appendChild(participantDiv);
    });
}
}

// === セッション管理クラス ===
class SessionManager {
    handleExpired() {
        state.sessionExpired = true;
        locationManager.stopSharing();
        state.clear();
        
        if (ui.elements.sessionStatus) {
            ui.elements.sessionStatus.innerHTML = '<span class="badge bg-danger">期限切れ</span>';
        }
        
        ui.updateStatus('location', 'error', 'セッションが期限切れです');
        
        const modal = new bootstrap.Modal(document.getElementById('session-expired-modal'));
        modal.show();
    }
    
leave() {
    if (confirm('セッションから退出しますか？')) {
        console.log('=== 退出処理開始 ===');
        
        // ボタンを無効化して多重クリックを防ぐ
        const leaveButton = document.getElementById('leave-session');
        if (leaveButton) {
            leaveButton.disabled = true;
            leaveButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 退出中...';
        }
        
        // 退出フラグを設定
        state.isLeaving = true;
        state.sessionExpired = true;
        
        // ★ 重要：LocalStorageに退出フラグを保存（ページ遷移後も維持）
        localStorage.setItem(`leaving_${state.sessionId}`, 'true');
        localStorage.setItem(`leaving_timestamp_${state.sessionId}`, Date.now().toString());
        
        // WebSocket の再接続タイマーをすべてクリア
        if (wsManager.connectionInterval) {
            clearInterval(wsManager.connectionInterval);
            wsManager.connectionInterval = null;
        }
        if (wsManager.backgroundKeepAliveInterval) {
            clearInterval(wsManager.backgroundKeepAliveInterval);
            wsManager.backgroundKeepAliveInterval = null;
        }
        
        // 位置情報共有を停止
        if (locationManager.watchId) {
            navigator.geolocation.clearWatch(locationManager.watchId);
            locationManager.watchId = null;
        }
        locationManager.stopBackgroundLocationUpdate();
        
        // 自分のマーカーを即座に削除
        if (mapManager.markers[state.participantId]) {
            mapManager.removeMarker(state.participantId);
        }
        
        // 参加者リストから自分を即座に削除
        state.participantsData = state.participantsData.filter(p => p.participant_id !== state.participantId);
        state.previousParticipantsState.delete(state.participantId);
        participantManager.updateDisplay();
        
        // WebSocket接続がある場合は退出通知を送信
        if (wsManager.websocket && wsManager.websocket.readyState === WebSocket.OPEN) {
            const leaveData = {
                type: 'leave',
                participant_id: state.participantId,
                participant_name: state.getParticipantName(),
                session_id: state.sessionId,
                timestamp: new Date().toISOString(),
                final_leave: true
            };
            
            try {
                // 送信を試行
                wsManager.send(leaveData);
                
                // 即座に WebSocket を閉じる（応答を待たない）
                wsManager.websocket.onclose = null;
                wsManager.websocket.onerror = null;
                wsManager.websocket.onopen = null;
                wsManager.websocket.onmessage = null;
                wsManager.websocket.close(1000, 'user_leave');
                wsManager.websocket = null;
                
                // 少し待ってから画面遷移
                setTimeout(() => {
                    this.finalizeLeave();
                }, 500);
                
            } catch (error) {
                console.warn('退出通知送信エラー:', error);
                this.finalizeLeave();
            }
        } else {
            // WebSocket未接続の場合は即座に終了
            this.finalizeLeave();
        }
    }
}

finalizeLeave() {
    console.log('=== 最終退出処理開始 ===');
    
    // 退出フラグが確実に設定されていることを確認
    state.isLeaving = true;
    state.sessionExpired = true;
    
    // ★ LocalStorageの退出フラグを更新
    localStorage.setItem(`leaving_${state.sessionId}`, 'true');
    localStorage.setItem(`leaving_timestamp_${state.sessionId}`, Date.now().toString());
    
    // WebSocketを完全に無効化
    if (wsManager.websocket) {
        wsManager.websocket.onclose = null;
        wsManager.websocket.onerror = null;
        wsManager.websocket.onopen = null;
        wsManager.websocket.onmessage = null;
        try {
            wsManager.websocket.close(1000, 'user_leave');
        } catch (e) {
            console.warn('WebSocket close error:', e);
        }
        wsManager.websocket = null;
    }
    
    // タイマーをクリア
    if (wsManager.connectionInterval) {
        clearInterval(wsManager.connectionInterval);
        wsManager.connectionInterval = null;
    }
    if (wsManager.backgroundKeepAliveInterval) {
        clearInterval(wsManager.backgroundKeepAliveInterval);
        wsManager.backgroundKeepAliveInterval = null;
    }
    
    // 状態をクリア（エラーを無視）
    try {
        state.clear();
    } catch (error) {
        console.warn('状態クリアエラー:', error);
    }
    
    // チャットマネージャーのクリーンアップ
    if (window.chatManager) {
        try {
            chatManager.cleanup();
        } catch (error) {
            console.warn('チャットクリーンアップエラー:', error);
        }
    }
    
    // UIクリーンアップ
    try {
        ui.cleanup();
    } catch (error) {
        console.warn('UIクリーンアップエラー:', error);
    }
    
    // ホーム画面に移動
    window.location.href = '/';
}
}
// === バックグラウンド管理クラス ===
class BackgroundManager {
    constructor() {
        this.backgroundStateTimeout = null;
        this.isPageUnloading = false;
        this.foregroundRestoreTimeout = null; // 追加
        this.setupVisibilityHandlers();
    }
    
    setupVisibilityHandlers() {
        // 可視性変更の即座検出
        document.addEventListener('visibilitychange', () => {
            const wasInBackground = state.isInBackground;
            const newBackgroundState = document.hidden;
            
            
            // 全てのタイムアウトをクリア
            if (this.backgroundStateTimeout) {
                clearTimeout(this.backgroundStateTimeout);
                this.backgroundStateTimeout = null;
            }
            if (this.foregroundRestoreTimeout) {
                clearTimeout(this.foregroundRestoreTimeout);
                this.foregroundRestoreTimeout = null;
            }
            
            // 即座に状態変更
            if (newBackgroundState && !wasInBackground) {
                this.handleTransition(true);
            } else if (!newBackgroundState && wasInBackground) {
                this.isPageUnloading = false; // 確実にリセット
                this.handleImmediateForegroundReturn(); // 即座復帰専用メソッド
            }
        });
        
        // ページフォーカス喪失（即座検出）
        window.addEventListener('blur', () => {
            if (!state.isInBackground && !this.isPageUnloading) {
                this.handleTransition(true);
            }
        });
        
        // ページフォーカス復帰 - 最優先処理
        window.addEventListener('focus', () => {
            if (state.isInBackground && !this.isPageUnloading) {
                this.isPageUnloading = false;
                this.handleImmediateForegroundReturn(); // 即座復帰
            }
        });
        
        // モバイル向け：pagehide の即座検出
        window.addEventListener('pagehide', (e) => {
            this.isPageUnloading = true;
            if (!state.isInBackground) {
                this.handleTransition(true);
            }
        });
        
        // モバイル向け：pageshow の復帰検出 - 最優先処理
        window.addEventListener('pageshow', (e) => {
            if (e.persisted && state.isInBackground) {
                this.isPageUnloading = false;
                this.handleImmediateForegroundReturn(); // 即座復帰
            }
        });
        
        // beforeunload での事前通知（即座実行）
        window.addEventListener('beforeunload', () => {
            this.isPageUnloading = true;
            if (!state.isInBackground) {
                this.handleTransition(true);
            }
        });
    }
    
// BackgroundManager の handleImmediateForegroundReturn メソッドを修正
handleImmediateForegroundReturn() {
    
    // 状態を即座にフォアグラウンドに変更
    const wasInBackground = state.isInBackground;
    state.isInBackground = false;
    
    // UI を即座に更新
    ui.updateStatus('visibility', 'active', 'アクティブ');
    locationManager.updateLocationStatus();
    
    // WebSocket関連の即座処理
    wsManager.stopBackgroundKeepAlive();
    state.backgroundReconnectAttempts = 0;
    
    // WebSocket再接続または状態通知を即座実行
    if (!wsManager.websocket || wsManager.websocket.readyState !== WebSocket.OPEN) {
        wsManager.init();
    } else {
        this.sendImmediateForegroundUpdate();
    }
    
    // ★ 修正：メソッド呼び出しを削除または適切な処理に置き換え
    // this.restoreLocationSharingImmediate(); // この行を削除
    
    // 位置共有の復元処理（必要に応じて）
    if (state.isSharing && state.lastKnownPosition) {
        // 最後の位置を即座に送信
        locationManager.sendLocationUpdate(state.lastKnownPosition);
    }
    
}
    
    // ：即座フォアグラウンド状態通知
    sendImmediateForegroundUpdate() {
        const statusData = {
            type: 'immediate_foreground_return', // 新しいタイプ
            participant_id: state.participantId,
            participant_name: state.getParticipantName(),
            is_background: false,
            has_position: !!state.lastKnownPosition,
            is_sharing: state.isSharing,
            is_mobile: wsManager.isMobileDevice(),
            page_returning: true,
            immediate_transition: true,
            priority_update: true, // 最優先フラグ
            timestamp: new Date().toISOString()
        };
        
        const sent = wsManager.send(statusData);
        
        // 送信失敗時の再試行
        if (!sent) {
            setTimeout(() => {
                if (wsManager.websocket && wsManager.websocket.readyState === WebSocket.OPEN) {
                    wsManager.send(statusData);
                }
            }, 100);
        }
    }

    handleTransition(toBackground) {
        if (this.isPageUnloading && !toBackground) {
            return;
        }
        
        const wasInBackground = state.isInBackground;
        state.isInBackground = toBackground;
        
        
        if (toBackground) {
            ui.updateStatus('visibility', 'background', 'バックグラウンド');
            locationManager.updateLocationStatus();
            wsManager.startBackgroundKeepAlive();
            this.sendBackgroundStatusUpdate(true, this.isPageUnloading);
        } else {
            ui.updateStatus('visibility', 'active', 'アクティブ');
            locationManager.updateLocationStatus();
            wsManager.stopBackgroundKeepAlive();
            state.backgroundReconnectAttempts = 0;
            
            if (!wsManager.websocket || wsManager.websocket.readyState !== WebSocket.OPEN) {
                wsManager.init();
            } else {
                this.sendBackgroundStatusUpdate(false, false);
            }
            
            // 共有状態の自動復元
            const savedState = state.load();
            if (savedState && savedState.isSharing && !state.isSharing && !state.sessionExpired) {
                setTimeout(() => {
                    locationManager.startSharing();
                }, 1000);
            }
        }
    }
    
    sendBackgroundStatusUpdate(isBackground, isPageUnloading = false) {
        const statusData = {
            type: 'background_status_update',
            participant_id: state.participantId,
            participant_name: state.getParticipantName(),
            is_background: isBackground,
            has_position: !!state.lastKnownPosition,
            is_sharing: state.isSharing,
            is_mobile: wsManager.isMobileDevice(),
            page_unloading: isPageUnloading,
            maintain_active: isPageUnloading,
            timestamp: new Date().toISOString(),
            immediate_transition: true
        };
        
        const sent = wsManager.send(statusData);
        
        // sendBeacon を使用した確実な送信（ページ閉じ時）
        if (isPageUnloading && navigator.sendBeacon) {
            try {
                const beaconData = new Blob([JSON.stringify({
                    session_id: state.sessionId,
                    participant_id: state.participantId,
                    action: 'background_transition',
                    timestamp: new Date().toISOString(),
                    immediate: true
                })], { type: 'application/json' });
                
                navigator.sendBeacon('/api/background-status/', beaconData);
            } catch (error) {
                console.warn('sendBeacon failed:', error);
            }
        }
    }
}

// === イベントハンドラー管理クラス ===
class EventHandlerManager {
    constructor() {
        this.setupEventListeners();
    }
    
    setupEventListeners() {
        // 共有ボタン
        if (ui.elements.toggleSharing) {
            ui.addEventListener(ui.elements.toggleSharing, 'click', () => {
                if (state.isSharing) {
                    locationManager.stopSharing();
                } else {
                    const modal = new bootstrap.Modal(document.getElementById('permission-modal'));
                    modal.show();
                }
            });
        }
        
        // ビューリセットボタン
        const resetViewBtn = document.getElementById('reset-view');
        if (resetViewBtn) {
            ui.addEventListener(resetViewBtn, 'click', () => mapManager.resetAutoFit());
        }
        
        // セッション退出ボタン
        const leaveSessionBtn = document.getElementById('leave-session');
        if (leaveSessionBtn) {
            ui.addEventListener(leaveSessionBtn, 'click', () => sessionManager.leave());
        }
        
        // 位置情報許可ボタン
        const requestLocationBtn = document.getElementById('request-location');
        if (requestLocationBtn) {
            ui.addEventListener(requestLocationBtn, 'click', () => {
                const modal = bootstrap.Modal.getInstance(document.getElementById('permission-modal'));
                if (modal) modal.hide();
                locationManager.startSharing();
            });
        }
        
        // 名前変更リスナー
        this.setupNameChangeListener();
    }
    
    setupNameChangeListener() {
        if (ui.elements.participantName) {
            let nameUpdateTimeout;
            let nameValidationTimeout;
            
            ui.addEventListener(ui.elements.participantName, 'input', function() {
                let newName = this.value.trim();
                if (newName.length > 30) {
                    newName = newName.substring(0, 30);
                    this.value = newName;
                }
                
                // リアルタイム重複チェック（入力中）
                clearTimeout(nameValidationTimeout);
                nameValidationTimeout = setTimeout(() => {
                    eventHandlerManager.validateNameDuplicate(newName, this);
                }, 300);
                
                // 自分のマーカー即座更新
                if (mapManager.markers[state.participantId]) {
                    const color = mapManager.getParticipantColor(state.participantId);
                    const customIcon = mapManager.createCustomMarker(
                        newName || `参加者${state.participantId.substring(0, 4)}`, 
                        color, 
                        state.isInBackground
                    );
                    mapManager.markers[state.participantId].setIcon(customIcon);
                }
                
                state.save();
                
                clearTimeout(nameUpdateTimeout);
                nameUpdateTimeout = setTimeout(() => {
                    // 最終的な名前更新送信前にもチェック
                    eventHandlerManager.sendNameUpdateIfValid(newName);
                }, 800);
            });
            
            // フォーカス離脱時の最終チェック
            ui.addEventListener(ui.elements.participantName, 'blur', function() {
                const finalName = this.value.trim();
                if (finalName) {
                    eventHandlerManager.validateAndUpdateName(finalName, this);
                }
            });
        }
    }
    // === ：名前重複チェック ===
    validateNameDuplicate(newName, inputElement) {
        if (!newName) {
            this.clearNameValidation(inputElement);
            return;
        }
        
        const normalizedNewName = newName.toLowerCase();
        
        // 現在の参加者リストから自分以外で同じ名前をチェック
        const isDuplicate = state.participantsData.some(participant => {
            const participantName = (participant.participant_name || '').trim().toLowerCase();
            return participant.participant_id !== state.participantId && 
                   participantName === normalizedNewName &&
                   participant.is_online; // オンラインの参加者のみチェック
        });
        
        if (isDuplicate) {
            this.showNameDuplicateWarning(inputElement, newName);
        } else {
            this.clearNameValidation(inputElement);
        }
    }
    
    // === ：重複警告表示 ===
    showNameDuplicateWarning(inputElement, duplicateName) {
        // 既存の警告を削除
        this.clearNameValidation(inputElement);
        
        // 入力欄のスタイルを警告色に
        inputElement.classList.add('is-invalid');
        
        // 警告メッセージを作成
        const warningDiv = document.createElement('div');
        warningDiv.className = 'invalid-feedback name-duplicate-warning';
        warningDiv.innerHTML = `
            <i class="fas fa-exclamation-triangle"></i> 
            「${duplicateName.substring(0, 20)}」は既に使用されています
        `;
        
        // 入力欄の後に警告を挿入
        inputElement.parentNode.insertBefore(warningDiv, inputElement.nextSibling);
        
        // グローバル通知も表示
        ui.showNotification(
            `名前「${duplicateName.substring(0, 20)}」は既に使用されています`, 
            'warning', 
            'fas fa-user-times',
            false
        );
    }
    
    // === ：名前検証クリア ===
    clearNameValidation(inputElement) {
        inputElement.classList.remove('is-invalid', 'is-valid');
        
        // 既存の警告メッセージを削除
        const existingWarning = inputElement.parentNode.querySelector('.name-duplicate-warning');
        if (existingWarning) {
            existingWarning.remove();
        }
    }
    
    // === ：有効な名前の場合のみ送信 ===
    sendNameUpdateIfValid(newName) {
    if (!newName) return;
    
    const normalizedNewName = newName.toLowerCase();
    
    // 最終重複チェック
    const isDuplicate = state.participantsData.some(participant => {
        const participantName = (participant.participant_name || '').trim().toLowerCase();
        return participant.participant_id !== state.participantId && 
               participantName === normalizedNewName &&
               participant.is_online;  // ★ 修正：オンライン参加者のみチェック
    });
    
    if (isDuplicate) {
        
        if (ui.elements.participantName) {
            this.showNameDuplicateWarning(ui.elements.participantName, newName);
        }
        return;
    }
    
    // 重複なしの場合は送信
    const nameUpdateData = {
        type: 'name_update',
        participant_id: state.participantId,
        participant_name: newName,
        check_duplicate: true,
        cleanup_old_offline: true,  // ★ 古いオフライン参加者のクリーンアップを要求
        timestamp: new Date().toISOString()
    };
    
    const sent = wsManager.send(nameUpdateData);
    if (sent) {
        
        // ★ ローカルでも古いオフライン参加者を削除
        this.cleanupLocalOldOfflineParticipants(newName);
        
        if (ui.elements.participantName) {
            ui.elements.participantName.classList.remove('is-invalid');
            ui.elements.participantName.classList.add('is-valid');
            
            setTimeout(() => {
                if (ui.elements.participantName) {
                    ui.elements.participantName.classList.remove('is-valid');
                }
            }, 2000);
        }
    }
}

// ★ 新規メソッドを追加
cleanupLocalOldOfflineParticipants(newName) {
    const normalizedNewName = newName.toLowerCase();
    
    // ローカルの参加者データから古いオフライン参加者を削除
    state.participantsData = state.participantsData.filter(participant => {
        const participantName = (participant.participant_name || '').trim().toLowerCase();
        
        // 同じ名前のオフライン参加者を削除（自分以外）
        if (participant.participant_id !== state.participantId &&
            participantName === normalizedNewName &&
            !participant.is_online) {
            
            
            // マーカーも削除
            if (mapManager.markers[participant.participant_id]) {
                mapManager.removeMarker(participant.participant_id);
            }
            
            return false;  // フィルターから除外
        }
        
        return true;  // 維持
    });
    
    // 参加者リストを更新
    participantManager.updateDisplay();
}
    
    // === ：名前検証と更新 ===
    validateAndUpdateName(finalName, inputElement) {
        const normalizedFinalName = finalName.toLowerCase();
        
        const isDuplicate = state.participantsData.some(participant => {
            const participantName = (participant.participant_name || '').trim().toLowerCase();
            return participant.participant_id !== state.participantId && 
                   participantName === normalizedFinalName &&
                   participant.is_online;
        });
        
        if (isDuplicate) {
            // 重複の場合、一意な名前を提案
            const suggestedName = this.generateUniqueName(finalName);
            
            const confirmChange = confirm(
                `「${finalName}」は既に使用されています。\n` +
                `「${suggestedName}」に変更しますか？\n\n` +
                `キャンセルすると元の名前に戻ります。`
            );
            
            if (confirmChange) {
                inputElement.value = suggestedName;
                this.sendNameUpdateIfValid(suggestedName);
                ui.showNotification(`名前を「${suggestedName}」に変更しました`, 'success');
            } else {
                // 元の名前に戻す
                const currentName = state.participantsData.find(p => p.participant_id === state.participantId)?.participant_name || '';
                inputElement.value = currentName;
                this.clearNameValidation(inputElement);
            }
        } else {
            // 重複なしの場合
            this.sendNameUpdateIfValid(finalName);
        }
    }
    
    // === ：一意な名前を生成 ===
    generateUniqueName(baseName) {
        let counter = 1;
        let suggestedName = `${baseName}${counter}`;
        
        while (counter < 100) { // 無限ループ防止
            const normalizedSuggested = suggestedName.toLowerCase();
            
            const exists = state.participantsData.some(participant => {
                const participantName = (participant.participant_name || '').trim().toLowerCase();
                return participant.participant_id !== state.participantId && 
                       participantName === normalizedSuggested &&
                       participant.is_online;
            });
            
            if (!exists) {
                return suggestedName.substring(0, 30); // 長さ制限
            }
            
            counter++;
            suggestedName = `${baseName}${counter}`;
        }
        
        // 最終手段：ランダム数字を追加
        const randomSuffix = Math.floor(Math.random() * 1000);
        return `${baseName}${randomSuffix}`.substring(0, 30);
    }
}

// === アプリケーション初期化と制御 ===
class LocationSharingApp {
    constructor() {
        this.initializeComponents();
        this.setupPeriodicTasks();
        this.setupPageUnloadHandler();
    }
    
    initializeComponents() {
        // グローバルインスタンスを作成
        window.state = new LocationSharingState();
        window.ui = new UIManager();
        window.wsManager = new WebSocketManager();
        window.messageHandler = new MessageHandler();
        window.locationManager = new LocationManager();
        window.mapManager = new MapManager();
        window.participantManager = new ParticipantManager();
        window.sessionManager = new SessionManager();
        window.backgroundManager = new BackgroundManager();
        window.eventHandlerManager = new EventHandlerManager();
        window.chatManager = new ChatManager();
        // 短縮参照を作成
        window.state = state;
        window.ui = ui;
        window.wsManager = wsManager;
        window.messageHandler = messageHandler;
        window.locationManager = locationManager;
        window.mapManager = mapManager;
        window.participantManager = participantManager;
        window.sessionManager = sessionManager;
        window.backgroundManager = backgroundManager;
        
    }
    
async init() {
    console.log('=== アプリケーション初期化開始 ===');
    
    // ★ 追加：退出フラグをチェック
    const leavingFlag = localStorage.getItem(`leaving_${state.sessionId}`);
    const leavingTimestamp = localStorage.getItem(`leaving_timestamp_${state.sessionId}`);
    
    if (leavingFlag === 'true' && leavingTimestamp) {
        const elapsed = Date.now() - parseInt(leavingTimestamp);
        // 10秒以内の退出フラグは有効とみなす
        if (elapsed < 10000) {
            console.log('退出処理中のため初期化を中止');
            // フラグをクリア
            localStorage.removeItem(`leaving_${state.sessionId}`);
            localStorage.removeItem(`leaving_timestamp_${state.sessionId}`);
            // ホーム画面にリダイレクト
            window.location.href = '/';
            return;
        } else {
            // 古いフラグはクリア
            localStorage.removeItem(`leaving_${state.sessionId}`);
            localStorage.removeItem(`leaving_timestamp_${state.sessionId}`);
        }
    }
    
    // マップを初期化
    mapManager.init();
    
    // 保存された状態を復元
    this.restoreSessionState();
    
    // 参加者リストを初期状態に設定
    if (ui.elements.participantsList) {
        ui.elements.participantsList.innerHTML = '<div class="text-center text-muted">参加者情報を読み込み中...</div>';
    }
    
    // WebSocket接続を開始（即座に）
    wsManager.init();
    
    // 初期ステータス更新
    ui.updateCountdown();
    ui.updateStatus('visibility', 'active', 'アクティブ');
}
    
    restoreSessionState() {
        
        const savedState = state.load();
        if (!savedState) {
            return;
        }
        
        // 名前の復元
        if (savedState.participantName && ui.elements.participantName) {
            ui.elements.participantName.value = savedState.participantName;
        }
        
        // 位置情報の復元
        if (savedState.lastPosition) {
            state.lastKnownPosition = {
                coords: {
                    latitude: savedState.lastPosition.latitude,
                    longitude: savedState.lastPosition.longitude,
                    accuracy: savedState.lastPosition.accuracy
                },
                timestamp: savedState.lastPosition.timestamp
            };
        }
        
        // 共有状態の復元
        if (savedState.isSharing) {
            const timeSinceSharing = Date.now() - (savedState.savedAt || 0);
            if (timeSinceSharing < CONFIG.POSITION_CACHE_DURATION) {
                
                setTimeout(() => {
                    if (!state.isSharing && !state.sessionExpired) {
                        ui.showNotification('前回の共有状態を復元しました', 'info');
                        locationManager.startSharing();
                    }
                }, 1500);
            } else {
                state.clear();
            }
        }
    }
    
    setupPeriodicTasks() {
        // カウントダウン更新
        setInterval(() => ui.updateCountdown(), 1000);
        
        // 参加者表示更新
        setInterval(() => participantManager.updateDisplay(), CONFIG.PARTICIPANTS_UPDATE);
        
        // 定期的な状態保存
        setInterval(() => {
            if (state.isSharing) {
                state.save();
            }
        }, 30000);
    }
    
    // === アプリケーション初期化と制御 - setupPageUnloadHandler メソッドの修正 ===
setupPageUnloadHandler() {
    // beforeunload は BackgroundManager で処理されるので、ここでは WebSocket の適切な終了のみ行う
    window.addEventListener('beforeunload', (e) => {
        
        // WebSocket接続を適切に閉じる
        if (wsManager.websocket && wsManager.websocket.readyState === WebSocket.OPEN) {
            try {
                // 正常終了コードで閉じる
                wsManager.websocket.close(1000, 'page_unload');
            } catch (error) {
                console.warn('WebSocket close error:', error);
            }
        }
        // チャットマネージャーのクリーンアップ
        if (window.chatManager) {
            chatManager.cleanup();
        }
        
        // クリーンアップ
        ui.cleanup();
    });
    
    // unload でも念のため処理
    window.addEventListener('unload', () => {
        
        if (wsManager.websocket) {
            try {
                wsManager.websocket.close(1000, 'page_unload');
            } catch (error) {
                console.warn('Final WebSocket close error:', error);
            }
        }
    });
    
    // pagehide - モバイルやタブ切り替え対応
    window.addEventListener('pagehide', (e) => {
        
        if (wsManager.websocket && wsManager.websocket.readyState === WebSocket.OPEN) {
            try {
                wsManager.websocket.close(1000, 'page_unload');
            } catch (error) {
                console.warn('Pagehide WebSocket close error:', error);
            }
        }
    });
}
}

// === ユーティリティ関数 ===
function requestLocation() {
    const modal = bootstrap.Modal.getInstance(document.getElementById('permission-modal'));
    if (modal) modal.hide();
    locationManager.startSharing();
}

function goToHome() {
    window.location.href = '/';
}

// === データ整合性とセキュリティ ===
function validateData() {
    const data = window.djangoData;
    
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    if (!uuidRegex.test(data.sessionId)) {
        console.error('Invalid session ID format');
        window.location.href = '/';
        return false;
    }
    
    if (!uuidRegex.test(data.participantId)) {
        console.error('Invalid participant ID format');
        window.location.href = '/';
        return false;
    }
    
    const expiresDate = new Date(data.expiresAt);
    if (isNaN(expiresDate.getTime())) {
        console.error('Invalid expires date format');
        window.location.href = '/';
        return false;
    }
    
    if (expiresDate <= new Date()) {
        console.warn('Session already expired');
        const modal = document.getElementById('session-expired-modal');
        if (modal) {
            const bsModal = new bootstrap.Modal(modal);
            bsModal.show();
        }
        return false;
    }
    
    return true;
}
// === チャット管理クラス ===
class ChatManager {
    constructor() {
        this.currentChatTarget = null;
        this.messages = {
            group: [],
            individual: {}
        };
        this.unreadCounts = {
            group: 0,
            individual: {}
        };
        this.typingTimers = {};
        this.isTyping = {};
        this.participantStatusInterval = null;
        this.rapidStatusInterval = null;
        this.scrollPosition = 0;
        
        this.initElements();
        this.startStatusUpdateTimer();
        this.loadMessages();
        
        // モーダル外クリックで閉じる
        this.chatModal?.addEventListener('click', (e) => {
            if (e.target === this.chatModal) {
                this.closeChat();
            }
        });
        this.typingStates = {}; // 入力状態を管理
        this.typingCheckIntervals = {}; // 入力状態チェック用インターバル
        // 二重タップ防止用のフラグ
        this.isTransitioning = false;
        this.lastTapTime = 0;
    }
    
    initElements() {
    this.chatButton = document.getElementById('chat-button');
    this.chatBadge = document.getElementById('chat-badge');
    this.chatModal = document.getElementById('chat-modal');
    
    // イベントリスナー
    this.chatButton?.addEventListener('click', () => this.openChat());
    
    // モーダル外クリックで閉じる
    this.chatModal?.addEventListener('click', (e) => {
        if (e.target === this.chatModal) {
            this.closeChat();
        }
    });
    
    // 入力中表示のイベントリスナーを追加
        const groupInput = document.getElementById('group-input');
        const individualInput = document.getElementById('individual-input');
    
        if (groupInput) {
            // 入力開始時
            groupInput.addEventListener('input', () => {
                this.handleTypingStart('group', groupInput);
            });
            
            // フォーカス喪失時
            groupInput.addEventListener('blur', () => {
                this.handleTypingEnd('group');
            });
        }
        
        if (individualInput) {
            individualInput.addEventListener('input', () => {
                if (this.currentChatTarget) {
                    this.handleTypingStart(this.currentChatTarget, individualInput);
                }
            });
            
            individualInput.addEventListener('blur', () => {
                if (this.currentChatTarget) {
                    this.handleTypingEnd(this.currentChatTarget);
                }
            });
        }

        
    
    // 文字数カウンターを追加
    ['group-input', 'individual-input'].forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;
        
        // 既存のカウンターがあれば削除
        const existingCounter = input.parentElement.querySelector('.char-counter');
        if (existingCounter) {
            existingCounter.remove();
        }
        
        // 文字数カウンター要素を作成
        const counter = document.createElement('div');
        counter.className = 'char-counter';
        counter.style.cssText = `
            position: absolute;
            right: 50px;
            bottom: 10px;
            font-size: 11px;
            color: #999;
            pointer-events: none;
        `;
        counter.textContent = '0/200';
        input.parentElement.style.position = 'relative';
        input.parentElement.appendChild(counter);
        
        // 入力時に文字数を更新
        input.addEventListener('input', () => {
            const length = input.value.length;
            counter.textContent = `${length}/200`;
            
            if (length > 200) {
                counter.style.color = '#dc3545';
                counter.style.fontWeight = 'bold';
                input.style.borderColor = '#dc3545';
            } else if (length > 180) {
                counter.style.color = '#ffc107';
                counter.style.fontWeight = 'normal';
                input.style.borderColor = '';
            } else {
                counter.style.color = '#999';
                counter.style.fontWeight = 'normal';
                input.style.borderColor = '';
            }
        });
        
        // Enterキーで送信
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const length = input.value.trim().length;
                if (length > 200) {
                    this.showMessageLengthError(id === 'group-input' ? 'group' : 'individual');
                    return;
                }
                
                if (id === 'group-input') {
                    this.sendGroupMessage();
                } else {
                    this.sendIndividualMessage();
                }
            }
        });
    });
    
    // iOS ズーム防止
    const inputs = document.querySelectorAll('.chat-input, #participant-name');
    inputs.forEach(input => {
        input.addEventListener('focus', (e) => {
            if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
                e.preventDefault();
                e.target.style.fontSize = '16px';
                setTimeout(() => {
                    e.target.setSelectionRange(e.target.value.length, e.target.value.length);
                }, 0);
            }
        });
        
        let lastTouchEnd = 0;
        input.addEventListener('touchend', (e) => {
            const now = Date.now();
            if (now - lastTouchEnd <= 300) {
                e.preventDefault();
            }
            lastTouchEnd = now;
        });
    });
}
    
    // 新規メソッド：入力開始処理
    handleTypingStart(target, inputElement) {
        const hasContent = inputElement.value.trim().length > 0;
        
        // 初めて文字が入力された場合
        if (hasContent && !this.typingStates[target]) {
            this.typingStates[target] = true;
            
            // 入力中通知を送信
            this.sendTypingIndicator(target, true);
            
            // 定期的に入力状態をチェック
            this.startTypingCheck(target, inputElement);
        }
        
        // 文字が全て削除された場合
        if (!hasContent && this.typingStates[target]) {
            this.handleTypingEnd(target);
        }
    }
    
    // 新規メソッド：入力終了処理
    handleTypingEnd(target) {
        if (this.typingStates[target]) {
            this.typingStates[target] = false;
            
            // 入力終了通知を送信
            this.sendTypingIndicator(target, false);
            
            // チェックインターバルをクリア
            this.stopTypingCheck(target);
        }
    }
    
    // 新規メソッド：定期的な入力状態チェック
    startTypingCheck(target, inputElement) {
        // 既存のインターバルをクリア
        this.stopTypingCheck(target);
        
        // 500msごとに入力状態をチェック
        this.typingCheckIntervals[target] = setInterval(() => {
            const hasContent = inputElement.value.trim().length > 0;
            
            if (!hasContent && this.typingStates[target]) {
                // 内容が空になったら入力終了
                this.handleTypingEnd(target);
            } else if (hasContent && this.typingStates[target]) {
                // まだ入力中の場合は継続通知を送信（10秒ごと）
                const now = Date.now();
                const lastSent = this.lastTypingSent?.[target] || 0;
                
                if (now - lastSent > 10000) { // 10秒経過
                    this.sendTypingIndicator(target, true);
                    if (!this.lastTypingSent) this.lastTypingSent = {};
                    this.lastTypingSent[target] = now;
                }
            }
        }, 500);
    }
    
    // 新規メソッド：入力状態チェック停止
    stopTypingCheck(target) {
        if (this.typingCheckIntervals[target]) {
            clearInterval(this.typingCheckIntervals[target]);
            delete this.typingCheckIntervals[target];
        }
    }
    
    // 新規メソッド：入力中通知送信
    sendTypingIndicator(target, isTyping) {
        wsManager.send({
            type: 'typing_indicator',
            chat_type: target === 'group' ? 'group' : 'individual',
            target_id: target === 'group' ? null : target,
            sender_id: state.participantId,
            sender_name: this.getParticipantNameSafe(),
            is_typing: isTyping
        });
    }

    loadMessages() {
        this.messages = { group: [], individual: {} };
        this.unreadCounts = { group: 0, individual: {} };
        
        // WebSocket接続後にサーバーから履歴と未読カウントを要求
        const checkAndRequest = () => {
            if (wsManager && wsManager.websocket && 
                wsManager.websocket.readyState === WebSocket.OPEN) {
                const participantId = state.participantId || window.djangoData.participantId;
                
                if (participantId) {
                    wsManager.send({
                        type: 'request_chat_history',
                        session_id: state.sessionId,
                        participant_id: participantId
                    });
                } else {
                    console.error('Participant ID not available');
                    setTimeout(checkAndRequest, 500);
                }
            } else {
                setTimeout(checkAndRequest, 500);
            }
        };
        
        setTimeout(checkAndRequest, 1000);
    }
    
    handleChatHistory(data) {
    if (!data.messages) return;
    
    
    // メッセージを復元
    this.messages = { group: [], individual: {} };
    
    // グループメッセージを復元
    if (Array.isArray(data.messages.group)) {
        this.messages.group = data.messages.group;
    }
    
    // 個別メッセージを復元
    if (data.messages.individual) {
        Object.keys(data.messages.individual).forEach(conversationPartnerId => {
            if (!this.messages.individual[conversationPartnerId]) {
                this.messages.individual[conversationPartnerId] = [];
            }
            
            this.messages.individual[conversationPartnerId] = 
                data.messages.individual[conversationPartnerId];
        });
    }
    
    // 未読カウントを復元（修正版）
    if (data.unread_counts) {
        // サーバーから受け取った未読数を使用
        this.unreadCounts = {
            group: data.unread_counts.group || 0,
            individual: data.unread_counts.individual || {}
        };
        
    } else {
        // サーバーから未読数が提供されない場合のフォールバック
        this.calculateUnreadCountsWithSessionCheck();
    }
    
    // UIを更新
    this.updateBadge();
    this.updateParticipantsList();
    
    // 現在開いているチャットを再描画
    const activeGroupChat = document.getElementById('group-chat-screen')?.classList.contains('active');
    const activeIndividualChat = document.getElementById('individual-chat-screen')?.classList.contains('active');
    
    if (activeGroupChat) {
        this.renderGroupMessages();
    } else if (activeIndividualChat && this.currentChatTarget) {
        this.renderIndividualMessages(this.currentChatTarget);
    }
    
}
calculateUnreadCountsWithSessionCheck() {
    const participantId = state.participantId || window.djangoData.participantId;
    
    // セッションストレージから最後に読んだメッセージのタイムスタンプを取得
    const lastReadTimestamps = this.getLastReadTimestamps();
    
    // グループメッセージの未読数を計算
    this.unreadCounts.group = this.messages.group.filter(msg => {
        // 自分のメッセージは除外
        if (msg.sender_id === participantId) return false;
        
        // 既読フラグが設定されている場合
        if (msg.is_read) return false;
        
        // 最後に読んだ時刻より新しいメッセージのみ未読とする
        const msgTime = new Date(msg.timestamp).getTime();
        const lastReadTime = lastReadTimestamps.group || 0;
        return msgTime > lastReadTime;
    }).length;
    
    // 個別メッセージの未読数を計算
    this.unreadCounts.individual = {};
    
    Object.keys(this.messages.individual).forEach(conversationPartnerId => {
        const lastReadTime = lastReadTimestamps.individual[conversationPartnerId] || 0;
        
        const unreadCount = this.messages.individual[conversationPartnerId].filter(msg => {
            // 自分が送信したメッセージは除外
            if (msg.sender_id === participantId) return false;
            
            // 自分宛でないメッセージは除外
            if (msg.target_id !== participantId) return false;
            
            // 既読フラグが設定されている場合
            if (msg.is_read) return false;
            
            // 最後に読んだ時刻より新しいメッセージのみ未読とする
            const msgTime = new Date(msg.timestamp).getTime();
            return msgTime > lastReadTime;
        }).length;
        
        if (unreadCount > 0) {
            this.unreadCounts.individual[conversationPartnerId] = unreadCount;
        }
    });
    
}

// ：最後に読んだメッセージのタイムスタンプを管理
getLastReadTimestamps() {
    const key = `lastRead_${state.sessionId}_${state.participantId}`;
    const stored = sessionStorage.getItem(key);
    
    if (stored) {
        try {
            return JSON.parse(stored);
        } catch (e) {
            console.warn('Failed to parse last read timestamps:', e);
        }
    }
    
    return {
        group: 0,
        individual: {}
    };
}
setLastReadTimestamp(chatType, targetId = null) {
    const key = `lastRead_${state.sessionId}_${state.participantId}`;
    const timestamps = this.getLastReadTimestamps();
    const now = Date.now();
    
    if (chatType === 'group') {
        timestamps.group = now;
    } else if (targetId) {
        if (!timestamps.individual) {
            timestamps.individual = {};
        }
        timestamps.individual[targetId] = now;
    }
    
    sessionStorage.setItem(key, JSON.stringify(timestamps));
}
calculateUnreadCounts() {
    const participantId = state.participantId || window.djangoData.participantId;
    
    // グループメッセージの未読数を計算
    this.unreadCounts.group = this.messages.group.filter(msg => 
        msg.sender_id !== participantId && !msg.is_read
    ).length;
    
    // 個別メッセージの未読数を計算
    this.unreadCounts.individual = {};
    
    Object.keys(this.messages.individual).forEach(conversationPartnerId => {
        const unreadCount = this.messages.individual[conversationPartnerId].filter(msg => 
            msg.sender_id !== participantId && 
            msg.target_id === participantId && 
            !msg.is_read
        ).length;
        
        if (unreadCount > 0) {
            this.unreadCounts.individual[conversationPartnerId] = unreadCount;
        }
    });
    
}
openChat() {
    this.chatModal.style.display = 'flex';
    // 次のフレームでopenクラスを追加（アニメーション発動）
    requestAnimationFrame(() => {
        this.chatModal.classList.add('open');
    });
    
    this.showParticipantsList();
    this.updateParticipantsList();
    this.startRapidStatusUpdate();
    
    if (window.innerWidth <= 768) {
        document.body.classList.add('chat-modal-open');
        this.scrollPosition = window.scrollY;
        document.body.style.top = `-${this.scrollPosition}px`;
    }
}

closeChat() {
    this.chatModal.classList.remove('open');
    // アニメーション完了後に非表示
    setTimeout(() => {
        this.chatModal.style.display = 'none';
    }, 300);
    
    this.stopRapidStatusUpdate();
    
    if (window.innerWidth <= 768) {
        document.body.classList.remove('chat-modal-open');
        document.body.style.top = '';
        window.scrollTo(0, this.scrollPosition || 0);
    }
}
    
    showParticipantsList() {
        document.querySelectorAll('.chat-screen').forEach(screen => {
            screen.classList.remove('active');
        });
        document.getElementById('participants-screen').classList.add('active');
        this.updateParticipantsList();
    }
    
updateParticipantsList() {
    const listEl = document.getElementById('chat-participant-list');
    if (!listEl) return;
    
    // 既存のイベントリスナーをクリア
    listEl.innerHTML = '';
    
    const groupUnread = this.unreadCounts.group || 0;
    const lastGroupMsg = this.messages.group[this.messages.group.length - 1];
    
    // グループセクションラベル
    const groupSectionLabel = document.createElement('div');
    groupSectionLabel.className = 'chat-section-label group-section';
    groupSectionLabel.innerHTML = `
        <i class="fas fa-users"></i>
        <span>グループ</span>
    `;
    listEl.appendChild(groupSectionLabel);
    
    // グループチャット項目
    const groupItem = document.createElement('div');
    groupItem.className = 'chat-participant-item group';
    groupItem.innerHTML = `
        <div class="participant-avatar">
            <i class="fas fa-users"></i>
        </div>
        <div class="participant-info">
            <div class="participant-name">
                <i class="fas fa-globe"></i> 全員
            </div>
            <div class="last-message">
                ${lastGroupMsg ? this.truncateMessage(lastGroupMsg.text) : '全員でチャットしよう！'}
            </div>
        </div>
        ${lastGroupMsg ? `<div class="message-time">${this.formatTime(lastGroupMsg.timestamp)}</div>` : ''}
        ${groupUnread > 0 ? `<div class="unread-badge">${groupUnread}</div>` : ''}
    `;
    
    // グループチャットのクリックイベントを直接設定
    groupItem.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openGroupChat();
    });
    
    // タッチイベントも追加（モバイル対応）
    groupItem.addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openGroupChat();
    });
    
    listEl.appendChild(groupItem);
    
    // ★ 修正：参加者リストを名前順でソート（自分以外）
    const sortedParticipants = [...state.participantsData]
        .filter(p => p.participant_id !== state.participantId)
        .sort((a, b) => {
            // 名前でソート（大文字小文字を無視）
            const nameA = (a.participant_name || `参加者${a.participant_id.substring(0, 4)}`).toLowerCase();
            const nameB = (b.participant_name || `参加者${b.participant_id.substring(0, 4)}`).toLowerCase();
            
            // 名前が同じ場合はparticipant_idでソート（一貫性のため）
            if (nameA === nameB) {
                return a.participant_id.localeCompare(b.participant_id);
            }
            
            return nameA.localeCompare(nameB);
        });
    
    const hasParticipants = sortedParticipants.length > 0;
    
    if (hasParticipants) {
        // 個別セクションラベル
        const individualSectionLabel = document.createElement('div');
        individualSectionLabel.className = 'chat-section-label individual-section';
        individualSectionLabel.innerHTML = `
            <i class="fas fa-user"></i>
            <span>個別チャット</span>
        `;
        listEl.appendChild(individualSectionLabel);
        
        // ★ 修正：ソート済みの参加者を順番に表示
        sortedParticipants.forEach(participant => {
            const name = participant.participant_name || `参加者${participant.participant_id.substring(0, 4)}`;
            const initials = name.substring(0, 2).toUpperCase();
            const participantId = participant.participant_id;
            
            let statusClass = '';
            let statusText = '';
            
            if (!participant.is_online) {
                statusClass = 'offline';
                statusText = 'オフライン';
            } else if (participant.is_background) {
                statusClass = 'background';
                statusText = 'バックグラウンド';
            } else if (participant.status === 'sharing') {
                statusClass = 'sharing';
                statusText = '位置共有中';
            } else {
                statusClass = 'waiting';
                statusText = '共有待機中';
            }
            
            const messages = this.messages.individual[participantId] || [];
            const lastMsg = messages[messages.length - 1];
            const unread = this.unreadCounts.individual[participantId] || 0;
            
            const participantItem = document.createElement('div');
            participantItem.className = 'chat-participant-item';
            participantItem.innerHTML = `
                <div class="participant-avatar" style="background: ${mapManager.getParticipantColor(participantId)};">
                    ${initials}
                    <div class="status-indicator ${statusClass}"></div>
                </div>
                <div class="participant-info">
                    <div class="participant-name">${this.escapeHtml(name)}</div>
                    <div class="last-message">
                        ${lastMsg ? this.truncateMessage(lastMsg.text) : 'タップしてチャット開始'}
                    </div>
                    <div class="participant-status ${statusClass}">${statusText}</div>
                </div>
                ${lastMsg ? `<div class="message-time">${this.formatTime(lastMsg.timestamp)}</div>` : ''}
                ${unread > 0 ? `<div class="unread-badge">${unread}</div>` : ''}
            `;
            
            // 個別チャットのクリックイベントを直接設定
            participantItem.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openIndividualChat(participantId, name);
            });
            
            // タッチイベントも追加（モバイル対応）
            participantItem.addEventListener('touchend', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openIndividualChat(participantId, name);
            });
            
            listEl.appendChild(participantItem);
        });
    } else {
        // 参加者がいない場合の表示
        const emptyDiv = document.createElement('div');
        emptyDiv.style.cssText = 'text-align: center; padding: 20px; color: #999;';
        emptyDiv.innerHTML = `
            <i class="fas fa-user-friends" style="font-size: 48px; opacity: 0.3;"></i>
            <p style="margin-top: 10px;">他の参加者を待っています...</p>
        `;
        listEl.appendChild(emptyDiv);
    }
}
    
openGroupChat() {
    // 二重タップ防止
    if (this.isTransitioning) return;
    
    const now = Date.now();
    if (now - this.lastTapTime < 300) return;
    this.lastTapTime = now;
    
    this.isTransitioning = true;
    
    document.querySelectorAll('.chat-screen').forEach(screen => {
        screen.classList.remove('active');
    });
    document.getElementById('group-chat-screen').classList.add('active');
    
    // 最後に読んだタイムスタンプを更新
    this.setLastReadTimestamp('group');
    
    // 未読メッセージがある場合は既読にする
    if (this.unreadCounts.group > 0) {
        wsManager.send({
            type: 'mark_as_read',
            participant_id: state.participantId,
            chat_type: 'group'
        });
        
        // ローカルの未読カウントをリセット
        this.unreadCounts.group = 0;
        this.updateBadge();
    }
    
    this.renderGroupMessages();
    this.scrollToBottom('group-messages');
    
    // チャット画面を開いた後の新着メッセージ監視を開始
    this.startAutoReadMonitoring('group');
    
    // トランジション完了後にフラグをリセット
    setTimeout(() => {
        this.isTransitioning = false;
    }, 300);
}
    
openIndividualChat(participantId, participantName) {
    // 二重タップ防止
    if (this.isTransitioning) return;
    
    const now = Date.now();
    if (now - this.lastTapTime < 300) return;
    this.lastTapTime = now;
    
    this.isTransitioning = true;
    this.currentChatTarget = participantId;
    
    document.querySelectorAll('.chat-screen').forEach(screen => {
        screen.classList.remove('active');
    });
    document.getElementById('individual-chat-screen').classList.add('active');
    document.getElementById('individual-chat-title').textContent = participantName;
    
    // 最後に読んだタイムスタンプを更新
    this.setLastReadTimestamp('individual', participantId);
    
    // 未読メッセージがある場合は既読にする
    const unreadCount = this.unreadCounts.individual[participantId] || 0;
    if (unreadCount > 0) {
        wsManager.send({
            type: 'mark_as_read',
            participant_id: state.participantId,
            chat_type: 'individual',
            sender_id: participantId
        });
        
        // ローカルの未読カウントをリセット
        this.unreadCounts.individual[participantId] = 0;
        this.updateBadge();
    }
    
    this.renderIndividualMessages(participantId);
    this.scrollToBottom('individual-messages');
    
    // チャット画面を開いた後の新着メッセージ監視を開始
    this.startAutoReadMonitoring('individual', participantId);
    
    // トランジション完了後にフラグをリセット
    setTimeout(() => {
        this.isTransitioning = false;
    }, 300);
}
    startAutoReadMonitoring(chatType, targetId = null) {
    // 既存の監視を停止
    if (this.autoReadInterval) {
        clearInterval(this.autoReadInterval);
    }
    
    // 100msごとに新着メッセージをチェックして自動既読
    this.autoReadInterval = setInterval(() => {
        const isChatModalOpen = this.chatModal.style.display !== 'none';
        if (!isChatModalOpen) {
            clearInterval(this.autoReadInterval);
            return;
        }
        
        if (chatType === 'group') {
            const isGroupChatOpen = document.getElementById('group-chat-screen')?.classList.contains('active');
            if (isGroupChatOpen && this.unreadCounts.group > 0) {
                this.markAsReadImmediately('group');
            }
        } else if (chatType === 'individual' && targetId) {
            const isIndividualChatOpen = document.getElementById('individual-chat-screen')?.classList.contains('active');
            const isCurrentChat = this.currentChatTarget === targetId;
            if (isIndividualChatOpen && isCurrentChat && this.unreadCounts.individual[targetId] > 0) {
                this.markAsReadImmediately('individual', targetId);
            }
        }
    }, 100);
}
    sendGroupMessage() {
        const input = document.getElementById('group-input');
        const text = input.value.trim();
        
        if (!text) return;
        
        if (text.length > 200) {
            this.showMessageLengthError('group');
            return;
        }
        
        // 入力状態をクリア
        this.handleTypingEnd('group');
        
        const message = {
            type: 'chat_message',
            chat_type: 'group',
            sender_id: state.participantId,
            sender_name: this.getParticipantNameSafe(),
            text: text,
            timestamp: new Date().toISOString()
        };
        
        wsManager.send(message);
        this.addMessage('group', null, message);
        
        input.value = '';
        
        // 文字数カウンターをリセット
        const counter = input.parentElement.querySelector('.char-counter');
        if (counter) {
            counter.textContent = '0/200';
            counter.style.color = '#999';
            counter.style.fontWeight = 'normal';
        }
        input.style.borderColor = '';
    }
    
    sendIndividualMessage() {
        const input = document.getElementById('individual-input');
        const text = input.value.trim();
        
        if (!text || !this.currentChatTarget) return;
        
        if (text.length > 200) {
            this.showMessageLengthError('individual');
            return;
        }
        
        // 入力状態をクリア
        this.handleTypingEnd(this.currentChatTarget);
        
        const message = {
            type: 'chat_message',
            chat_type: 'individual',
            sender_id: state.participantId,
            sender_name: this.getParticipantNameSafe(),
            target_id: this.currentChatTarget,
            text: text,
            timestamp: new Date().toISOString()
        };
        
        wsManager.send(message);
        this.addMessage('individual', this.currentChatTarget, message);
        
        input.value = '';
        
        // 文字数カウンターをリセット
        const counter = input.parentElement.querySelector('.char-counter');
        if (counter) {
            counter.textContent = '0/200';
            counter.style.color = '#999';
            counter.style.fontWeight = 'normal';
        }
        input.style.borderColor = '';
    }

// ：文字数エラー表示メソッド
showMessageLengthError(chatType) {
    const inputId = chatType === 'group' ? 'group-input' : 'individual-input';
    const input = document.getElementById(inputId);
    
    // エラーメッセージを表示
    const errorDiv = document.createElement('div');
    errorDiv.className = 'chat-error-message';
    errorDiv.style.cssText = `
        position: absolute;
        bottom: 60px;
        left: 10px;
        right: 10px;
        background: #dc3545;
        color: white;
        padding: 8px 12px;
        border-radius: 8px;
        font-size: 12px;
        animation: shake 0.3s;
        z-index: 1000;
    `;
    errorDiv.innerHTML = `
        <i class="fas fa-exclamation-triangle"></i> 
        メッセージは200文字以内で入力してください（現在: ${input.value.length}文字）
    `;
    
    // 親要素に追加
    input.parentElement.style.position = 'relative';
    input.parentElement.appendChild(errorDiv);
    
    // 入力欄を赤くハイライト
    input.style.borderColor = '#dc3545';
    input.style.boxShadow = '0 0 0 0.2rem rgba(220, 53, 69, 0.25)';
    
    // 3秒後に削除
    setTimeout(() => {
        errorDiv.remove();
        input.style.borderColor = '';
        input.style.boxShadow = '';
    }, 3000);
}
    handleIncomingMessage(data) {
    if (data.sender_id === state.participantId) return;
    
    if (data.chat_type === 'group') {
        this.messages.group.push(data);
        
        // チャット画面とグループチャットが開いているかチェック
        const isGroupChatOpen = document.getElementById('group-chat-screen')?.classList.contains('active');
        const isChatModalOpen = this.chatModal.style.display !== 'none';
        
        if (isGroupChatOpen && isChatModalOpen) {
            // グループチャットを開いている場合は即座に既読にする
            this.markAsReadImmediately('group');
        } else {
            // 開いていない場合のみ未読カウントを増やす
            this.unreadCounts.group++;
            this.updateBadge();
        }
        
        // UIを更新
        if (isGroupChatOpen) {
            this.renderGroupMessages();
        }
        
        // 参加者リストが開いている場合も即座に更新
        if (document.getElementById('participants-screen')?.classList.contains('active')) {
            this.updateParticipantsList();
        }
        
        // 通知（チャットモーダルが閉じている場合のみ）
        if (!isChatModalOpen) {
            ui.showNotification(
                `${data.sender_name}: ${this.truncateMessage(data.text)}`,
                'info',
                'fas fa-comment'
            );
        }
    } else if (data.chat_type === 'individual') {
        // 自分宛てかチェック
        if (data.target_id === state.participantId) {
            const senderId = data.sender_id;
            
            if (!this.messages.individual[senderId]) {
                this.messages.individual[senderId] = [];
            }
            this.messages.individual[senderId].push(data);
            
            // 個別チャットが開いているかチェック
            const isIndividualChatOpen = document.getElementById('individual-chat-screen')?.classList.contains('active');
            const isCurrentChat = this.currentChatTarget === senderId;
            const isChatModalOpen = this.chatModal.style.display !== 'none';
            
            if (isIndividualChatOpen && isCurrentChat && isChatModalOpen) {
                // 該当の個別チャットを開いている場合は即座に既読にする
                this.markAsReadImmediately('individual', senderId);
            } else {
                // 開いていない場合のみ未読カウントを増やす
                if (!this.unreadCounts.individual[senderId]) {
                    this.unreadCounts.individual[senderId] = 0;
                }
                this.unreadCounts.individual[senderId]++;
                this.updateBadge();
            }
            
            // UIを更新
            if (isCurrentChat && isIndividualChatOpen) {
                this.renderIndividualMessages(senderId);
            }
            
            // 参加者リストが開いている場合も即座に更新
            if (document.getElementById('participants-screen')?.classList.contains('active')) {
                this.updateParticipantsList();
            }
            
            // 通知（チャットモーダルが閉じている場合のみ）
            if (!isChatModalOpen) {
                ui.showNotification(
                    `${data.sender_name}: ${this.truncateMessage(data.text)}`,
                    'info',
                    'fas fa-comment'
                );
            }
        }
    }
}
    markAsReadImmediately(chatType, senderId = null) {
    // 即座に既読マークを送信
    const markAsReadData = {
        type: 'mark_as_read',
        participant_id: state.participantId,
        chat_type: chatType
    };
    
    if (chatType === 'individual' && senderId) {
        markAsReadData.sender_id = senderId;
    }
    
    // WebSocketで既読通知を送信
    if (wsManager.websocket && wsManager.websocket.readyState === WebSocket.OPEN) {
        wsManager.send(markAsReadData);
    }
    
    // ローカルの未読カウントも即座にリセット
    if (chatType === 'group') {
        this.unreadCounts.group = 0;
    } else if (senderId) {
        if (this.unreadCounts.individual[senderId]) {
            this.unreadCounts.individual[senderId] = 0;
        }
    }
    
    // バッジを更新
    this.updateBadge();
    
    // タイムスタンプも更新
    this.setLastReadTimestamp(chatType, senderId);
}
    
    handleTypingIndicator(data) {
        if (data.sender_id === state.participantId) return;
        
        if (data.chat_type === 'group') {
            const indicator = document.getElementById('group-typing-indicator');
            if (indicator) {
                if (data.is_typing) {
                    indicator.querySelector('span').textContent = data.sender_name;
                    indicator.style.display = 'block';
                    
                    // タイムアウトをセット（15秒後に自動で非表示）
                    if (this.typingTimeouts?.group) {
                        clearTimeout(this.typingTimeouts.group);
                    }
                    if (!this.typingTimeouts) this.typingTimeouts = {};
                    this.typingTimeouts.group = setTimeout(() => {
                        indicator.style.display = 'none';
                    }, 15000);
                } else {
                    // 入力終了通知を受信したら即座に非表示
                    indicator.style.display = 'none';
                    if (this.typingTimeouts?.group) {
                        clearTimeout(this.typingTimeouts.group);
                        delete this.typingTimeouts.group;
                    }
                }
            }
        } else if (data.chat_type === 'individual' && data.target_id === state.participantId) {
            const indicator = document.getElementById('typing-indicator');
            if (indicator && this.currentChatTarget === data.sender_id) {
                if (data.is_typing) {
                    indicator.querySelector('span').textContent = data.sender_name;
                    indicator.style.display = 'block';
                    
                    // タイムアウトをセット（15秒後に自動で非表示）
                    if (this.typingTimeouts?.[data.sender_id]) {
                        clearTimeout(this.typingTimeouts[data.sender_id]);
                    }
                    if (!this.typingTimeouts) this.typingTimeouts = {};
                    this.typingTimeouts[data.sender_id] = setTimeout(() => {
                        indicator.style.display = 'none';
                    }, 15000);
                } else {
                    // 入力終了通知を受信したら即座に非表示
                    indicator.style.display = 'none';
                    if (this.typingTimeouts?.[data.sender_id]) {
                        clearTimeout(this.typingTimeouts[data.sender_id]);
                        delete this.typingTimeouts[data.sender_id];
                    }
                }
            }
        }
    }
    
    handleParticipantStatusUpdate(data) {
        // 参加者リストが表示されている場合は即座に更新
        if (this.chatModal.style.display !== 'none' && 
            document.getElementById('participants-screen').classList.contains('active')) {
            this.updateParticipantsList();
        }
    }
    
addMessage(type, target, message) {
    if (type === 'group') {
        this.messages.group.push(message);
        
        // グループチャットが開いている場合のみ再描画
        const isGroupChatOpen = document.getElementById('group-chat-screen')?.classList.contains('active');
        if (isGroupChatOpen) {
            // ★ 修正：自分のメッセージの場合は自動スクロール
            if (message.sender_id === state.participantId) {
                this.renderGroupMessages();
                this.scrollToBottom('group-messages');
            } else {
                this.renderGroupMessages();
            }
        }
    } else {
        const key = target || message.sender_id;
        if (!this.messages.individual[key]) {
            this.messages.individual[key] = [];
        }
        this.messages.individual[key].push(message);
        
        // 該当の個別チャットが開いている場合のみ再描画
        const isIndividualChatOpen = document.getElementById('individual-chat-screen')?.classList.contains('active');
        if (this.currentChatTarget === key && isIndividualChatOpen) {
            // ★ 修正：自分のメッセージの場合は自動スクロール
            if (message.sender_id === state.participantId) {
                this.renderIndividualMessages(key);
                this.scrollToBottom('individual-messages');
            } else {
                this.renderIndividualMessages(key);
            }
        }
    }
    
    // 参加者リストが開いていれば更新
    if (document.getElementById('participants-screen').classList.contains('active')) {
        this.updateParticipantsList();
    }
}
    
renderGroupMessages() {
    const container = document.getElementById('group-messages');
    if (!container) return;
    
    // スクロール位置を保存
    const wasScrolledToBottom = this.isScrolledToBottom(container);
    const scrollPosition = container.scrollTop;
    
    if (this.messages.group.length === 0) {
        container.innerHTML = `
            <div class="chat-welcome">
                <i class="fas fa-comments" style="font-size: 48px; color: #00b300; opacity: 0.3;"></i>
                <p style="color: #999; margin-top: 10px;">グループチャットへようこそ！</p>
            </div>
        `;
        return;
    }
    
    let html = '';
    let lastDate = null;
    
    this.messages.group.forEach(msg => {
        const msgDate = new Date(msg.timestamp).toLocaleDateString();
        if (msgDate !== lastDate) {
            html += `<div class="system-message">${msgDate}</div>`;
            lastDate = msgDate;
        }
        
        const isOwn = msg.sender_id === state.participantId;
        html += `
            <div class="message ${isOwn ? 'own' : ''}">
                <div class="message-bubble">
                    ${!isOwn ? `<div class="message-sender">${msg.sender_name}</div>` : ''}
                    <div>${this.escapeHtml(msg.text)}</div>
                    <div class="message-time-label">${this.formatTime(msg.timestamp)}</div>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
    
    // スクロール位置を復元または最下部へ
    if (wasScrolledToBottom) {
        this.scrollToBottom('group-messages');
    } else {
        container.scrollTop = scrollPosition;
        // ★ 修正：最後のメッセージが自分のものでない場合のみ新着表示
        const lastMessage = this.messages.group[this.messages.group.length - 1];
        if (lastMessage && lastMessage.sender_id !== state.participantId) {
            this.showNewMessageIndicator('group');
        }
    }
}
    
renderIndividualMessages(participantId) {
    const container = document.getElementById('individual-messages');
    if (!container) return;
    
    // スクロール位置を保存
    const wasScrolledToBottom = this.isScrolledToBottom(container);
    const scrollPosition = container.scrollTop;
    
    const messages = this.messages.individual[participantId] || [];
    
    if (messages.length === 0) {
        container.innerHTML = `
            <div class="chat-welcome">
                <i class="fas fa-comment" style="font-size: 48px; color: #00b300; opacity: 0.3;"></i>
                <p style="color: #999; margin-top: 10px;">チャットを開始しましょう！</p>
            </div>
        `;
        return;
    }
    
    let html = '';
    let lastDate = null;
    
    messages.forEach(msg => {
        const msgDate = new Date(msg.timestamp).toLocaleDateString();
        if (msgDate !== lastDate) {
            html += `<div class="system-message">${msgDate}</div>`;
            lastDate = msgDate;
        }
        
        const isOwn = msg.sender_id === state.participantId;
        html += `
            <div class="message ${isOwn ? 'own' : ''}">
                <div class="message-bubble">
                    <div>${this.escapeHtml(msg.text)}</div>
                    <div class="message-time-label">${this.formatTime(msg.timestamp)}</div>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
    
    // スクロール位置を復元または最下部へ
    if (wasScrolledToBottom) {
        this.scrollToBottom('individual-messages');
    } else {
        container.scrollTop = scrollPosition;
        // ★ 修正：最後のメッセージが自分のものでない場合のみ新着表示
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.sender_id !== state.participantId) {
            this.showNewMessageIndicator('individual', participantId);
        }
    }
}
    
isScrolledToBottom(element) {
    if (!element) return true;
    const threshold = 50; // 50px の余裕を持たせる
    return element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
}

showNewMessageIndicator(chatType, targetId = null) {
    const indicatorId = chatType === 'group' ? 'group-new-message-indicator' : 'individual-new-message-indicator';
    
    // ★ 修正：既存のインジケーターを削除してから新規作成
    let existingIndicator = document.getElementById(indicatorId);
    if (existingIndicator) {
        existingIndicator.remove();
    }
    
    const indicator = document.createElement('div');
    indicator.id = indicatorId;
    indicator.className = 'new-message-indicator';
    indicator.style.cssText = `
        position: absolute;
        bottom: 60px;
        left: 50%;
        transform: translateX(-50%);
        background: #007bff;
        color: white;
        padding: 8px 16px;
        border-radius: 20px;
        font-size: 12px;
        cursor: pointer;
        z-index: 1000;
        box-shadow: 0 2px 8px rgba(0, 123, 255, 0.3);
        animation: slideUpCenter 0.3s ease-out;
        pointer-events: auto;  /* ★ クリック可能を明示 */
    `;
    indicator.innerHTML = `
        <i class="fas fa-chevron-down"></i> 新着メッセージ
    `;
    
    const container = chatType === 'group' ? 
        document.getElementById('group-chat-screen') : 
        document.getElementById('individual-chat-screen');
    
    if (container) {
        container.style.position = 'relative';
        container.appendChild(indicator);
        
        // ★ 修正：クリックイベントを確実に設定
        const scrollHandler = (e) => {
            e.stopPropagation();  // ★ イベント伝播を停止
            const messagesContainer = chatType === 'group' ? 
                document.getElementById('group-messages') : 
                document.getElementById('individual-messages');
                
            this.scrollToBottom(messagesContainer.id);
            indicator.remove();
        };
        
        // ★ 修正：複数のイベントタイプに対応
        indicator.addEventListener('click', scrollHandler);
        indicator.addEventListener('touchstart', scrollHandler, { passive: true });
        
        // メッセージコンテナのスクロールイベントを監視
        const messagesContainer = chatType === 'group' ? 
            document.getElementById('group-messages') : 
            document.getElementById('individual-messages');
            
        if (messagesContainer) {
            const scrollMonitor = () => {
                if (this.isScrolledToBottom(messagesContainer)) {
                    indicator.remove();
                    messagesContainer.removeEventListener('scroll', scrollMonitor);
                }
            };
            messagesContainer.addEventListener('scroll', scrollMonitor);
        }
    }
}
    updateBadge() {
        let totalUnread = this.unreadCounts.group;
        Object.values(this.unreadCounts.individual).forEach(count => {
            totalUnread += count;
        });
        
        if (totalUnread > 0) {
            this.chatBadge.textContent = totalUnread > 99 ? '99+' : totalUnread;
            this.chatBadge.style.display = 'block';
        } else {
            this.chatBadge.style.display = 'none';
        }
    }
    
    startStatusUpdateTimer() {
        // 参加者リストのステータスを定期的に更新
        this.participantStatusInterval = setInterval(() => {
            if (this.chatModal.style.display !== 'none' && 
                document.getElementById('participants-screen').classList.contains('active')) {
                this.updateParticipantsList();
            }
        }, 2000); // 2秒ごとに更新
    }
    
    stopStatusUpdateTimer() {
        if (this.participantStatusInterval) {
            clearInterval(this.participantStatusInterval);
            this.participantStatusInterval = null;
        }
    }
    
    startRapidStatusUpdate() {
        // 既存のタイマーをクリア
        if (this.rapidStatusInterval) {
            clearInterval(this.rapidStatusInterval);
        }
        
        // チャットモーダルが開いている間は1秒ごとに更新
        this.rapidStatusInterval = setInterval(() => {
            if (this.chatModal.style.display !== 'none' && 
                document.getElementById('participants-screen').classList.contains('active')) {
                this.updateParticipantsList();
            }
        }, 1000); // 1秒ごと
    }
    
    stopRapidStatusUpdate() {
        if (this.rapidStatusInterval) {
            clearInterval(this.rapidStatusInterval);
            this.rapidStatusInterval = null;
        }
    }
    
    cleanup() {
        this.stopStatusUpdateTimer();
        this.stopRapidStatusUpdate();
        
        // 全ての入力状態をクリア
        Object.keys(this.typingStates).forEach(target => {
            this.handleTypingEnd(target);
        });
        
        // タイムアウトをクリア
        if (this.typingTimeouts) {
            Object.values(this.typingTimeouts).forEach(timeout => {
                clearTimeout(timeout);
            });
            this.typingTimeouts = {};
        }
        
        this.clearMessages();
    }

    
    clearMessages() {
        this.messages = { group: [], individual: {} };
        this.unreadCounts = { group: 0, individual: {} };
        this.updateBadge();
    }
    
    getParticipantNameSafe() {
        const name = state.getParticipantName();
        if (!name || name.trim() === '') {
            return `参加者${state.participantId.substring(0, 4)}`;
        }
        return name;
    }
    
    // ユーティリティ
    formatTime(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 60000) return '今';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
        if (diff < 86400000) return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        
        return date.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
    }
    
    truncateMessage(text, maxLength = 30) {
        if (!text) return '';
        return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    scrollToBottom(elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            setTimeout(() => {
                element.scrollTop = element.scrollHeight;
            }, 50);
        }
    }
}
// === アプリケーション開始 ===
document.addEventListener('DOMContentLoaded', function() {
    // データ整合性チェック
    if (!validateData()) {
        return;
    }
    
    // アプリケーションを初期化して開始
    const app = new LocationSharingApp();
    app.init().catch(error => {
        console.error('アプリケーション初期化エラー:', error);
        ui.showNotification('アプリケーションの初期化に失敗しました', 'error');
    });
});