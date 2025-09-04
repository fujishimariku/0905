document.addEventListener('DOMContentLoaded', function() {
    const expiresAt = new Date(window.djangoData.expiresAt);
    const shareUrl = window.djangoData.shareUrl;
    
    // LINEブラウザ回避用のURLを生成（統一関数）
    function getExternalBrowserUrl(url, source = 'qr') {
        // URLにパラメータを追加してLINEブラウザを回避
        const separator = url.includes('?') ? '&' : '?';
        const params = [
            'openExternalBrowser=1',
            `utm_source=${source}`,
            'utm_medium=social',
        ];
        return url + separator + params.join('&');
    }
    
    // QRコード生成の改善版
    function generateQRCode() {
        const qrContainer = document.getElementById('qr-code');
        
        if (typeof QRCode === 'undefined') {
            console.warn('QRCodeライブラリが読み込まれていません。代替手段を使用します。');
            generateQRCodeAlternative();
            return;
        }
        
        // 既存のコンテンツをクリア
        qrContainer.innerHTML = '';
        
        try {
            // canvas要素を作成
            const canvas = document.createElement('canvas');
            qrContainer.appendChild(canvas);
            
            // QRコードには外部ブラウザ用URLを使用
            const qrUrl = getExternalBrowserUrl(shareUrl, 'qr_code');
            
            QRCode.toCanvas(canvas, qrUrl, {
                width: 200,
                height: 200,
                margin: 2,
                color: {
                    dark: '#000000',
                    light: '#ffffff'
                },
                errorCorrectionLevel: 'M'
            }, function(error) {
                if (error) {
                    console.error('QRコード生成エラー:', error);
                    generateQRCodeAlternative();
                } else {
                }
            });
        } catch (error) {
            console.error('QRコード生成例外:', error);
            generateQRCodeAlternative();
        }
    }
    
    // 代替QRコード生成方法（複数の選択肢）
    function generateQRCodeAlternative() {
        const qrContainer = document.getElementById('qr-code');
        qrContainer.innerHTML = '';
        
        // 1. QR Server APIを試す
        if (!generateWithQRServer()) {
            // 2. Google Charts APIを試す
            if (!generateWithGoogleCharts()) {
                // 3. 最終的なフォールバック
                showQRCodeError();
            }
        }
    }
    
    // QR Server APIを使用
    function generateWithQRServer() {
        try {
            const qrContainer = document.getElementById('qr-code');
            const qrSize = 200;
            const qrUrl = getExternalBrowserUrl(shareUrl, 'qr_server');
            const encodedUrl = encodeURIComponent(qrUrl);
            
            // QR Server API（より信頼性が高い）
            const qrServerUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${qrSize}x${qrSize}&data=${encodedUrl}&format=png&margin=10`;
            
            const img = document.createElement('img');
            img.src = qrServerUrl;
            img.alt = 'QRコード';
            img.style.width = qrSize + 'px';
            img.style.height = qrSize + 'px';
            img.style.border = '1px solid #ddd';
            img.style.borderRadius = '8px';
            img.loading = 'lazy';
            
            img.onload = function() {
            };
            
            img.onerror = function() {
                console.warn('QR Server APIが利用できません。Google Charts APIを試します。');
                generateWithGoogleCharts();
            };
            
            qrContainer.appendChild(img);
            return true;
        } catch (error) {
            console.error('QR Server API エラー:', error);
            return false;
        }
    }
    
    // Google Charts APIを使用（フォールバック）
    function generateWithGoogleCharts() {
        try {
            const qrContainer = document.getElementById('qr-code');
            const qrSize = 200;
            const qrUrl = getExternalBrowserUrl(shareUrl, 'google_charts');
            const encodedUrl = encodeURIComponent(qrUrl);
            
            // Google Charts QR Code API
            const googleQRUrl = `https://chart.googleapis.com/chart?chs=${qrSize}x${qrSize}&cht=qr&chl=${encodedUrl}&choe=UTF-8&chld=M|2`;
            
            const img = document.createElement('img');
            img.src = googleQRUrl;
            img.alt = 'QRコード';
            img.style.width = qrSize + 'px';
            img.style.height = qrSize + 'px';
            img.style.border = '1px solid #ddd';
            img.style.borderRadius = '8px';
            img.loading = 'lazy';
            
            img.onload = function() {
            };
            
            img.onerror = function() {
                console.error('Google Charts APIも利用できません');
                showQRCodeError();
            };
            
            // 既存のコンテンツをクリア
            qrContainer.innerHTML = '';
            qrContainer.appendChild(img);
            return true;
        } catch (error) {
            console.error('Google Charts API エラー:', error);
            return false;
        }
    }
    
    // QRコード生成エラー時の表示
    function showQRCodeError() {
        const qrContainer = document.getElementById('qr-code');
        const qrSize = 200;
        
        qrContainer.innerHTML = `
            <div class="text-center p-3 border rounded" style="width: ${qrSize}px; height: ${qrSize}px; display: flex; flex-direction: column; justify-content: center; align-items: center; background-color: #f8f9fa;">
                <i class="fas fa-qrcode fa-3x text-muted mb-2"></i>
                <small class="text-muted">QRコードを生成できませんでした</small>
                <small class="text-muted">URLを直接共有してください</small>
                <button class="btn btn-sm btn-outline-primary mt-2" id="retry-qr-btn">
                    <i class="fas fa-redo"></i> 再試行
                </button>
            </div>
        `;
        
        // 再試行ボタンにイベントリスナーを追加
        const retryBtn = document.getElementById('retry-qr-btn');
        if (retryBtn) {
            retryBtn.addEventListener('click', function() {
                retryQRGeneration();
            });
        }
    }
    
    // QRコード生成の再試行
    function retryQRGeneration() {
        const qrContainer = document.getElementById('qr-code');
        qrContainer.innerHTML = `
            <div class="text-center p-3" style="width: 200px; height: 200px; display: flex; flex-direction: column; justify-content: center; align-items: center;">
                <i class="fas fa-spinner fa-spin fa-2x text-primary mb-2"></i>
                <small class="text-muted">QRコードを生成中...</small>
            </div>
        `;
        
        setTimeout(() => {
            generateQRCodeAlternative();
        }, 500);
    }
    
    // 改善されたQRライブラリ読み込み
    function loadQRCodeLibrary() {
        return new Promise((resolve, reject) => {
            // 既にライブラリが読み込まれている場合
            if (typeof QRCode !== 'undefined') {
                resolve();
                return;
            }
            
            const qrCodeCDNs = [
                'https://cdnjs.cloudflare.com/ajax/libs/qrcode/1.5.3/qrcode.min.js',
                'https://unpkg.com/qrcode@1.5.3/build/qrcode.min.js',
                'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js'
            ];
            
            let attemptIndex = 0;
            
            function tryLoadScript() {
                if (attemptIndex >= qrCodeCDNs.length) {
                    console.warn('全てのQRCodeライブラリの読み込みに失敗しました');
                    reject(new Error('QRCode library load failed'));
                    return;
                }
                
                const script = document.createElement('script');
                script.src = qrCodeCDNs[attemptIndex];
                script.async = true;
                
                script.onload = function() {
                    // 少し待ってからライブラリが利用可能か確認
                    setTimeout(() => {
                        if (typeof QRCode !== 'undefined') {
                            resolve();
                        } else {
                            attemptIndex++;
                            tryLoadScript();
                        }
                    }, 100);
                };
                
                script.onerror = function() {
                    console.warn('QRCodeライブラリ読み込み失敗:', qrCodeCDNs[attemptIndex]);
                    attemptIndex++;
                    tryLoadScript();
                };
                
                document.head.appendChild(script);
            }
            
            tryLoadScript();
        });
    }
    
    // QRコード生成の開始
    function initQRCode() {
        const qrContainer = document.getElementById('qr-code');
        qrContainer.innerHTML = `
            <div class="text-center p-3" style="width: 200px; height: 200px; display: flex; flex-direction: column; justify-content: center; align-items: center;">
                <i class="fas fa-spinner fa-spin fa-2x text-primary mb-2"></i>
                <small class="text-muted">QRコードを生成中...</small>
            </div>
        `;
        
        // QRライブラリの読み込みを試す
        loadQRCodeLibrary()
            .then(() => {
                // ライブラリ読み込み成功
                generateQRCode();
            })
            .catch(() => {
                // ライブラリ読み込み失敗、代替手段を使用
                console.warn('QRライブラリ読み込み失敗、代替手段を使用');
                generateQRCodeAlternative();
            });
    }
    
    // ページ読み込み完了後にQRコード生成開始
    setTimeout(initQRCode, 100);
    
    // カウントダウン
    function updateCountdown() {
        const now = new Date();
        const timeLeft = expiresAt - now;
        
        if (timeLeft <= 0) {
            document.getElementById('countdown').textContent = '期限切れ';
            document.getElementById('countdown').className = 'countdown text-danger';
            return;
        }
        
        const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
        const hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);
        
        let countdownText = '';
        if (days > 0) {
            countdownText = `${days}日 ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
            countdownText = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        
        document.getElementById('countdown').textContent = countdownText;
        
        // 残り時間が少ない場合の警告表示
        if (timeLeft < 60 * 60 * 1000) { // 1時間未満
            document.getElementById('countdown').className = 'countdown text-warning';
        } else if (timeLeft < 10 * 60 * 1000) { // 10分未満
            document.getElementById('countdown').className = 'countdown text-danger';
        }
    }
    
    updateCountdown();
    const countdownInterval = setInterval(updateCountdown, 1000);
    
    // ページが非表示になった時にインターバルを停止（パフォーマンス向上）
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            clearInterval(countdownInterval);
        } else {
            updateCountdown();
            // 新しいインターバルを開始
            setInterval(updateCountdown, 1000);
        }
    });
    
    // グローバル関数として公開（generateQRCodeAlternativeを他から使えるように）
    window.generateQRCodeAlternative = generateQRCodeAlternative;
    window.retryQRGeneration = retryQRGeneration;
});

// データ整合性チェック
(function() {
    const data = window.djangoData;
    
    // 日付フォーマットの検証
    const expiresDate = new Date(data.expiresAt);
    if (isNaN(expiresDate.getTime())) {
        console.error('Invalid expires date format');
        showErrorToast('日付データが無効です');
        return;
    }
    
    // 期限切れチェック
    if (expiresDate <= new Date()) {
        console.warn('Session already expired');
        const modal = new bootstrap.Modal(document.getElementById('session-expired-modal'));
        modal.show();
        return;
    }
    
    // URL検証
    try {
        const url = new URL(data.shareUrl);
        if (!url.protocol.match(/^https?:$/)) {
            throw new Error('Invalid protocol');
        }
    } catch (e) {
        console.error('Invalid share URL:', e);
        showErrorToast('共有URLが無効です');
    }
    
    // セッションID検証
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(data.sessionId)) {
        console.error('Invalid session ID format');
        showErrorToast('セッションIDが無効です');
    }
})();

// エラートースト表示関数
function showErrorToast(message) {
    const toast = document.getElementById('error-toast');
    const toastBody = document.getElementById('error-toast-body');
    
    if (toast && toastBody) {
        // XSS対策: textContentを使用
        toastBody.textContent = message;
        
        if (typeof bootstrap !== 'undefined' && bootstrap.Toast) {
            const bsToast = new bootstrap.Toast(toast);
            bsToast.show();
        } else {
            // Bootstrapが利用できない場合の簡易表示
            toast.style.display = 'block';
            setTimeout(() => {
                toast.style.display = 'none';
            }, 5000);
        }
    }
}

// 成功メッセージ表示関数
function showSuccessMessage(message) {
    const successElement = document.getElementById('copy-success');
    const errorElement = document.getElementById('copy-error');
    
    if (errorElement) {
        errorElement.style.display = 'none';
    }
    
    if (successElement) {
        successElement.textContent = message;
        successElement.style.display = 'block';
        
        // 5秒後に非表示
        setTimeout(() => {
            successElement.style.display = 'none';
        }, 5000);
    }
}

// 安全なクリップボードコピー（改良版）
async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            // フォールバック方法
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            textArea.style.opacity = '0';
            textArea.setAttribute('readonly', '');
            textArea.setAttribute('tabindex', '-1');
            
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            textArea.setSelectionRange(0, text.length);
            
            const successful = document.execCommand('copy');
            document.body.removeChild(textArea);
            
            if (!successful) {
                throw new Error('Copy command failed');
            }
        }
    } catch (error) {
        console.error('Copy to clipboard failed:', error);
        throw error;
    }
}

// LINEブラウザ回避用URL生成（グローバル関数）
function getExternalBrowserUrl(url, source = 'manual') {
    const separator = url.includes('?') ? '&' : '?';
    const params = [
        'openExternalBrowser=1',
        `utm_source=${source}`,
        'utm_medium=share',
        `utm_campaign=location_share`,
        `t=${Date.now()}` // キャッシュバスト用
    ];
    return url + separator + params.join('&');
}

// フォールバック共有（クリップボードコピー）
function fallbackShare(urlToShare = null) {
    const url = urlToShare || getExternalBrowserUrl(window.djangoData.shareUrl, 'fallback');
    
    copyToClipboard(url)
        .then(() => {
            showSuccessMessage('URLがクリップボードにコピーされました（外部ブラウザで開くよう設定済み）');
        })
        .catch(() => {
            showErrorToast('共有に失敗しました。URLを手動でコピーしてください。');
        });
}

// 統一された共有関数（その他のみ）
function shareGeneral() {
    try {
        // 外部ブラウザ回避用URLを生成
        const externalUrl = getExternalBrowserUrl(window.djangoData.shareUrl, 'general_share');
        
        // Web Share APIのサポートチェック
        if (navigator.share && typeof navigator.share === 'function') {
            // Web Share API使用（外部ブラウザ用URL）
            navigator.share({
                title: '位置情報共有',
                text: '位置情報を共有します',
                url: externalUrl
            }).then(() => {
                showSuccessMessage('共有が完了しました');
            }).catch(error => {
                // ユーザーがキャンセルした場合は何もしない
                if (error.name === 'AbortError') {
                    console.log('User cancelled share');
                } else {
                    console.error('Web Share API error:', error);
                    fallbackShare(externalUrl);
                }
            });
        } else {
            // Web Share APIが利用できない場合
            console.log('Web Share API not supported');
            fallbackShare(externalUrl);
        }
    } catch (error) {
        console.error('Share general error:', error);
        fallbackShare();
    }
}

// ホームページへの遷移関数
function goToHome() {
    // セキュリティ: 直接URLに移動ではなく、相対パスを使用
    window.location.href = '/';
}

// デバッグ用: 生成されたURLを確認する関数
function debugShowGeneratedUrl() {
    const externalUrl = getExternalBrowserUrl(window.djangoData.shareUrl, 'debug');
    return externalUrl;
}

// ページロード時の初期化
document.addEventListener('DOMContentLoaded', function() {
    // URLコピーボタンのイベント設定（外部ブラウザ用URL使用）
    const copyButton = document.getElementById('copy-url');
    const shareUrlInput = document.getElementById('share-url');
    
    if (copyButton && shareUrlInput) {
        // 入力フィールドに外部ブラウザ用URLを設定
        const externalUrl = getExternalBrowserUrl(window.djangoData.shareUrl, 'manual_copy');
        shareUrlInput.value = externalUrl;
        
        copyButton.addEventListener('click', function() {
            const button = this;
            const successMessage = document.getElementById('copy-success');
            const errorMessage = document.getElementById('copy-error');
            
            // メッセージをリセット
            if (successMessage) successMessage.style.display = 'none';
            if (errorMessage) errorMessage.style.display = 'none';
            
            copyToClipboard(shareUrlInput.value)
                .then(() => {
                    showSuccessMessage('URLがクリップボードにコピーされました');
                })
                .catch(() => {
                    if (errorMessage) {
                        errorMessage.style.display = 'block';
                    }
                    if (successMessage) {
                        successMessage.style.display = 'none';
                    }
                });
        });
    }
    
    // URLフィールドクリック時の全選択
    if (shareUrlInput) {
        shareUrlInput.addEventListener('click', function() {
            this.select();
        });
        
        // フォーカス時にも全選択
        shareUrlInput.addEventListener('focus', function() {
            this.select();
        });
    }
    
    // セッション期限切れの監視
    const expiresAt = new Date(window.djangoData.expiresAt);
    const checkExpiration = () => {
        if (new Date() >= expiresAt) {
            const modal = new bootstrap.Modal(document.getElementById('session-expired-modal'));
            modal.show();
        }
    };
    
    // 1分ごとにチェック
    setInterval(checkExpiration, 60000);
    
    // すべてのボタンにセキュリティ属性を追加
    document.querySelectorAll('button[data-action]').forEach(button => {
        button.setAttribute('rel', 'noopener noreferrer');
    });
    
    // 共有ボタンのイベント設定（onclickの代わり）
    const shareButton = document.getElementById('share-general');
    if (shareButton) {
        // 既存のイベントリスナーを削除（重複防止）
        shareButton.replaceWith(shareButton.cloneNode(true));
        
        // 新しいボタン要素を取得
        const newShareButton = document.getElementById('share-general');
        
        // クリックイベントを追加
        newShareButton.addEventListener('click', function(event) {
            event.preventDefault();
            event.stopPropagation();
            
            // ボタンの二重クリック防止
            if (this.disabled) {
                return;
            }
            
            // 一時的にボタンを無効化
            this.disabled = true;
            const originalText = this.innerHTML;
            this.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 処理中...';
            
            // 共有処理を実行
            try {
                shareGeneral();
            } catch (error) {
                console.error('Share error:', error);
                showErrorToast('共有処理でエラーが発生しました');
            }
            
            // ボタンを再度有効化
            setTimeout(() => {
                this.disabled = false;
                this.innerHTML = originalText;
            }, 1000);
        });
        
        // タッチイベントのサポート（モバイル対応）
        newShareButton.addEventListener('touchend', function(event) {
            // ダブルタップ防止
            if (event.cancelable) {
                event.preventDefault();
            }
            this.click();
        });
    }
    
    // その他の共有方法ボタン（複数ある場合に対応）
    const allShareButtons = document.querySelectorAll('[data-action="share-general"]');
    allShareButtons.forEach(function(button) {
        if (button.id !== 'share-general') {
            button.addEventListener('click', function(event) {
                event.preventDefault();
                shareGeneral();
            });
        }
    });
    
    // ホームボタンのイベント設定
    const homeButtons = document.querySelectorAll('[data-action="go-home"]');
    homeButtons.forEach(function(button) {
        button.addEventListener('click', function(event) {
            event.preventDefault();
            goToHome();
        });
    });
});

// CSPエラーハンドリング
window.addEventListener('securitypolicyviolation', function(e) {
    console.error('CSP Violation:', e.violatedDirective, e.blockedURI);
    showErrorToast('セキュリティポリシー違反が検出されました');
});