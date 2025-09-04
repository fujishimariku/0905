        // カスタムアラート機能
        function showCustomAlert(message, title = '', type = 'info', duration = 4000) {
            // 既存のアラートがあれば削除
            const existingAlert = document.querySelector('.custom-alert');
            if (existingAlert) {
                existingAlert.remove();
            }
            
            // アイコンを設定
            let icon = '';
            switch(type) {
                case 'success':
                    icon = '✓';
                    break;
                case 'warning':
                    icon = '⚠';
                    break;
                case 'error':
                    icon = '✕';
                    break;
                default:
                    icon = 'i';
            }
            
            // アラート要素を作成
            const alertDiv = document.createElement('div');
            alertDiv.className = `custom-alert ${type}`;
            alertDiv.innerHTML = `
                <span class="alert-icon">${icon}</span>
                <div class="alert-content">
                    ${title ? `<div class="alert-title">${title}</div>` : ''}
                    <div class="alert-message">${message}</div>
                </div>
                <button class="alert-close">&times;</button>
            `;
            
            // bodyに追加
            document.body.appendChild(alertDiv);
            
            // アニメーション表示
            setTimeout(() => alertDiv.classList.add('show'), 100);
            
            // 閉じるボタンのイベント
            const closeBtn = alertDiv.querySelector('.alert-close');
            closeBtn.addEventListener('click', () => hideAlert(alertDiv));
            
            // 自動で閉じる
            if (duration > 0) {
                setTimeout(() => hideAlert(alertDiv), duration);
            }
            
            return alertDiv;
        }
        
        function hideAlert(alertElement) {
            alertElement.classList.remove('show');
            setTimeout(() => {
                if (alertElement.parentNode) {
                    alertElement.parentNode.removeChild(alertElement);
                }
            }, 400);
        }
        
        document.addEventListener('DOMContentLoaded', function() {
            // ソーシャルメディアボタンの設定
            const socialButtons = document.querySelectorAll('.social-btn');
            
            socialButtons.forEach(button => {
                button.addEventListener('click', function(e) {
                    e.preventDefault();
                    
                    const socialType = this.getAttribute('data-social');
                    const currentUrl = window.location.href;
                    const title = document.title;
                    const description = '煩わしい処理は一切なし。誰でも気軽にサクッと位置シェア！';
                    
                    let shareUrl = '';
                    
                    switch(socialType) {
                        case 'twitter':
                            shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(currentUrl)}&hashtags=ちょいシェアMAP,ブラウザ動作,登録不要`;
                            //showCustomAlert('Twitterの共有ページを開きました', 'Twitter共有', 'success');
                            break;
                            
                        case 'facebook':
                            shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(currentUrl)}&quote=${encodeURIComponent(description)}`;
                            //showCustomAlert('Facebookの共有ページを開きました', 'Facebook共有', 'success');
                            break;
                    }
                    
                    if (shareUrl) {
                        // 新しいウィンドウでソーシャルメディア共有ページを開く
                        const windowFeatures = 'width=600,height=400,scrollbars=yes,resizable=yes';
                        const shareWindow = window.open(shareUrl, 'shareWindow', windowFeatures);
                        
                        // ポップアップがブロックされた場合の処理
                        if (!shareWindow || shareWindow.closed || typeof shareWindow.closed == 'undefined') {
                            showCustomAlert(
                                'ポップアップがブロックされました。ブラウザの設定でポップアップを許可してください。',
                                'ポップアップブロック',
                                'warning',
                                6000
                            );
                        }
                    }
                });
            });
            
            // ソーシャルボタンのホバーエフェクト強化
            socialButtons.forEach(button => {
                button.addEventListener('mouseenter', function() {
                    this.style.transform = 'translateY(-3px) scale(1.1)';
                });
                
                button.addEventListener('mouseleave', function() {
                    this.style.transform = 'translateY(0) scale(1)';
                });
            });
        });
        
        // 共有機能のヘルパー関数
        function shareToSocial(platform) {
            const url = window.location.href;
            const title = document.title;
            
            // Web Share API が利用可能な場合
            if (navigator.share && platform === 'native') {
                navigator.share({
                    title: title,
                    text: 'ちょいシェアMAPアプリをチェックしてみてください！',
                    url: url
                }).then(() => {
                    showCustomAlert('共有が完了しました', '共有完了', 'success');
                }).catch(err => {
                    if (err.name !== 'AbortError') {
                        showCustomAlert('共有に失敗しました', '共有エラー', 'error');
                    }
                });
            }
        }
        
        // グローバルにカスタムアラート機能を公開
        window.customAlert = showCustomAlert;
        window.hideAlert = hideAlert;