# tracker/views.py - セキュリティ強化版
from django.shortcuts import render, get_object_or_404, redirect
from django.http import JsonResponse, Http404
from django.views.decorators.csrf import csrf_exempt, csrf_protect
from django.views.decorators.http import require_http_methods
from django.utils import timezone
from django.contrib import messages
from django.core.mail import send_mail
from django.conf import settings
from django.template.loader import render_to_string
from django.utils.html import strip_tags, escape
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.views.decorators.cache import never_cache
from django.views.decorators.vary import vary_on_headers
from django.middleware.csrf import get_token
from django.utils.decorators import method_decorator
from django.views.decorators.gzip import gzip_page
from django.core.signing import Signer, BadSignature
from django.utils.crypto import get_random_string
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
import json
import uuid
import logging
import re
import bleach
from datetime import timedelta
from .models import LocationSession, LocationData, SessionLog

# ログ設定
logger = logging.getLogger(__name__)

# セキュリティ設定
MAX_PARTICIPANT_NAME_LENGTH = 30
MAX_MESSAGE_LENGTH = 2000
MAX_REQUESTS_PER_MINUTE = 60
ALLOWED_DURATION_CHOICES = [15, 30, 60, 120, 240, 480, 720]  # 許可された時間設定

def validate_participant_name(name):
    """参加者名のバリデーション"""
    if not name:
        return True  # 空の場合は許可
    
    if len(name) > MAX_PARTICIPANT_NAME_LENGTH:
        raise ValidationError(f'表示名は{MAX_PARTICIPANT_NAME_LENGTH}文字以内で入力してください。')
    
    # XSSを防ぐためHTMLタグを除去
    cleaned_name = bleach.clean(name, tags=[], strip=True)
    if cleaned_name != name:
        raise ValidationError('表示名にHTMLタグは使用できません。')
    
    # 不適切な文字をチェック
    if re.search(r'[<>"\']', name):
        raise ValidationError('表示名に不正な文字が含まれています。')
    
    return True

def validate_coordinates(latitude, longitude):
    """座標のバリデーション"""
    try:
        lat = float(latitude)
        lng = float(longitude)
        
        if not (-90 <= lat <= 90):
            raise ValidationError('緯度の値が範囲外です。')
        
        if not (-180 <= lng <= 180):
            raise ValidationError('経度の値が範囲外です。')
        
        return lat, lng
    except (TypeError, ValueError):
        raise ValidationError('座標の値が無効です。')

def validate_session_id(session_id):
    """セッションIDのバリデーション"""
    if not session_id:
        raise ValidationError('セッションIDが必要です。')
    
    # UUIDオブジェクトか文字列かを判定
    if isinstance(session_id, uuid.UUID):
        # 既にUUIDオブジェクトの場合はそのまま使用
        return True
    
    # 文字列の場合はUUIDフォーマットかチェック
    try:
        uuid.UUID(str(session_id))
    except (ValueError, TypeError):
        raise ValidationError('無効なセッションIDです。')
    
    return True

def validate_participant_id(participant_id):
    """参加者IDのバリデーション"""
    if not participant_id:
        raise ValidationError('参加者IDが必要です。')
    
    # UUIDオブジェクトか文字列かを判定
    if isinstance(participant_id, uuid.UUID):
        # 既にUUIDオブジェクトの場合はそのまま使用
        return True
    
    # 文字列の場合はUUIDフォーマットかチェック
    try:
        uuid.UUID(str(participant_id))
    except (ValueError, TypeError):
        raise ValidationError('無効な参加者IDです。')
    
    return True

def rate_limit_check(request, key_suffix=''):
    """レート制限チェック（簡易版）"""
    from django.core.cache import cache
    
    client_ip = get_client_ip(request)
    cache_key = f'rate_limit_{client_ip}_{key_suffix}'
    
    requests = cache.get(cache_key, 0)
    if requests >= MAX_REQUESTS_PER_MINUTE:
        return False
    
    cache.set(cache_key, requests + 1, 60)  # 1分間
    return True

@never_cache
def home(request):
    """ホームページ"""
    return render(request, 'tracker/home.html')

@csrf_protect
@never_cache
def contact(request):
    """お問い合わせページ - セキュリティ強化版"""
    if request.method == 'POST':
        # レート制限チェック
        if not rate_limit_check(request, 'contact'):
            error_message = 'リクエストが多すぎます。しばらく時間をおいてから再試行してください。'
            if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
                return JsonResponse({'success': False, 'message': error_message}, status=429)
            else:
                messages.error(request, error_message)
                return render(request, 'tracker/contact.html')
        
        try:
            # フォームデータを取得・サニタイズ
            name = bleach.clean(request.POST.get('name', '').strip(), tags=[], strip=True)
            email = request.POST.get('email', '').strip().lower()
            subject_category = request.POST.get('subject_category', '')
            subject = bleach.clean(request.POST.get('subject', '').strip(), tags=[], strip=True)
            message = bleach.clean(request.POST.get('message', '').strip(), tags=[], strip=True)
            
            # 使用環境情報（サニタイズ）
            user_agent = escape(request.POST.get('user_agent', ''))[:500]  # 長さ制限
            screen_resolution = escape(request.POST.get('screen_resolution', ''))[:50]
            browser_language = escape(request.POST.get('browser_language', ''))[:20]
            
            # バリデーション
            errors = []
            
            if not name:
                errors.append('お名前を入力してください。')
            elif len(name) > 100:
                errors.append('お名前は100文字以内で入力してください。')
            
            if not email:
                errors.append('メールアドレスを入力してください。')
            else:
                try:
                    validate_email(email)
                except ValidationError:
                    errors.append('有効なメールアドレスを入力してください。')
            
            # 件名カテゴリーのホワイトリストチェック
            allowed_categories = ['technical', 'feature', 'bug', 'general', 'other']
            if subject_category not in allowed_categories:
                errors.append('無効なお問い合わせ種類です。')
            
            if not message:
                errors.append('メッセージを入力してください。')
            elif len(message) > MAX_MESSAGE_LENGTH:
                errors.append(f'メッセージは{MAX_MESSAGE_LENGTH}文字以内で入力してください。')
            
            # 件名の長さチェック
            if subject and len(subject) > 200:
                errors.append('件名は200文字以内で入力してください。')
            
            if errors:
                if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
                    return JsonResponse({
                        'success': False,
                        'message': '\n'.join(errors)
                    })
                else:
                    for error in errors:
                        messages.error(request, error)
                    return render(request, 'tracker/contact.html')
            
            # 件名カテゴリーの日本語変換
            category_map = {
                'technical': '技術的な問題',
                'feature': '機能に関するご要望',
                'bug': 'バグ報告',
                'general': '一般的なお問い合わせ',
                'other': 'その他'
            }
            category_text = category_map.get(subject_category, 'その他')
            
            # メール件名の生成（エスケープ処理）
            if subject:
                email_subject = f'[チョイシェアMAP] {category_text}: {subject}'
            else:
                email_subject = f'[チョイシェアMAP] {category_text}'
            
            # 現在時刻を取得
            current_time = timezone.now()
            
            # メール本文の生成（管理者用）- XSS対策
            email_context = {
                'name': escape(name),
                'email': escape(email),
                'category': escape(category_text),
                'subject': escape(subject),
                'message': escape(message),
                'user_agent': user_agent,
                'screen_resolution': screen_resolution,
                'browser_language': browser_language,
                'ip_address': get_client_ip(request),
                'timestamp': current_time,
                'submitted_at': current_time,
            }
            
            # 自動返信用のコンテキスト
            auto_reply_context = {
                'name': escape(name),
                'email': escape(email),
                'category': escape(category_text),
                'subject': escape(subject),
                'message': escape(message),
                'submitted_at': current_time,
            }
            
            # HTMLメールテンプレート（管理者用）
            html_message = render_to_string('tracker/email/contact_notification.html', email_context)
            plain_message = strip_tags(html_message)
            
            # 管理者へのメール送信
            try:
                admin_email = getattr(settings, 'CONTACT_EMAIL', settings.DEFAULT_FROM_EMAIL)
                
                # 管理者メールアドレスの検証
                try:
                    validate_email(admin_email)
                except ValidationError:
                    logger.error(f'Invalid admin email address: {admin_email}')
                    raise Exception('管理者メールアドレスが無効です。')
                
                logger.info(f'Sending email to admin: {admin_email}')
                
                send_mail(
                    subject=email_subject,
                    message=plain_message,
                    from_email=settings.DEFAULT_FROM_EMAIL,
                    recipient_list=[admin_email],
                    html_message=html_message,
                    fail_silently=False,
                )
                
                logger.info('Admin email sent successfully')
                
                # 送信者への自動返信メール
                auto_reply_html = render_to_string('tracker/email/contact_auto_reply.html', auto_reply_context)
                auto_reply_plain = strip_tags(auto_reply_html)
                
                send_mail(
                    subject='[チョイシェアMAP] お問い合わせを受け付けました',
                    message=auto_reply_plain,
                    from_email=settings.DEFAULT_FROM_EMAIL,
                    recipient_list=[email],
                    html_message=auto_reply_html,
                    fail_silently=True,
                )
                
                logger.info('Auto-reply email sent successfully')
                logger.info(f'Contact form submitted: {name} <{email}> - {category_text}')
                
            except Exception as e:
                logger.error(f'Failed to send contact email: {str(e)}')
                
                error_message = 'メール送信でエラーが発生しました。しばらく時間をおいてから再試行してください。'
                
                if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
                    return JsonResponse({
                        'success': False,
                        'message': error_message
                    })
                else:
                    messages.error(request, error_message)
                    return render(request, 'tracker/contact.html')
            
            # 成功時のレスポンス
            success_message = 'お問い合わせありがとうございます。メッセージを正常に送信いたしました。内容を確認次第、ご返信させていただきます。'
            
            if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
                return JsonResponse({
                    'success': True,
                    'message': success_message
                })
            else:
                messages.success(request, success_message)
                return redirect('tracker:contact')
                
        except Exception as e:
            logger.error(f'Contact form error: {str(e)}')
            
            generic_error = '予期しないエラーが発生しました。しばらく時間をおいてから再試行してください。'
            
            if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
                return JsonResponse({
                    'success': False,
                    'message': generic_error
                })
            else:
                messages.error(request, generic_error)
                return render(request, 'tracker/contact.html')
    
    # GET リクエストの場合
    return render(request, 'tracker/contact.html')

@csrf_protect
@require_http_methods(["POST"])
def create_session(request):
    """新しい位置共有セッションを作成 - セキュリティ強化版"""
    # レート制限チェック
    if not rate_limit_check(request, 'create_session'):
        messages.error(request, 'リクエストが多すぎます。しばらく時間をおいてから再試行してください。')
        return redirect('tracker:home')
    
    try:
        duration = int(request.POST.get('duration', 30))
    except (ValueError, TypeError):
        messages.error(request, '無効な時間設定です。')
        return redirect('tracker:home')
    
    # 許可された時間設定かチェック
    if duration not in ALLOWED_DURATION_CHOICES:
        messages.error(request, '無効な時間設定です。')
        return redirect('tracker:home')
    
    try:
        session = LocationSession.objects.create(duration_minutes=duration)
        
        # ログ記録
        SessionLog.objects.create(
            session=session,
            action='created',
            ip_address=get_client_ip(request),
            user_agent=request.META.get('HTTP_USER_AGENT', '')[:500]  # 長さ制限
        )
        
        return redirect('tracker:session_created', session_id=str(session.session_id))  # str()で明示的に変換
        
    except Exception as e:
        logger.error(f'Session creation error: {str(e)}')
        messages.error(request, 'セッションの作成に失敗しました。')
        return redirect('tracker:home')

# session_created関数の修正
@never_cache
def session_created(request, session_id):
    """セッション作成完了ページ - セキュリティ強化版"""
    try:
        validate_session_id(session_id)
    except ValidationError:
        raise Http404("セッションが見つかりません")
    
    session = get_object_or_404(LocationSession, session_id=session_id)
    
    if session.is_expired():
        messages.error(request, 'このセッションは期限切れです。')
        return redirect('tracker:home')
    
    # 共有URLを安全に生成
    share_url = request.build_absolute_uri(f'/share/{str(session.session_id)}')  # str()で明示的に変換
    
    context = {
        'session': session,
        'share_url': share_url,
        'expires_at': session.expires_at,
        'session_id_str': str(session.session_id),  # テンプレート用の文字列版session_id
        'nonce': get_random_string(16),  # CSP用nonce
    }
    return render(request, 'tracker/session_created.html', context)

@never_cache
@vary_on_headers('User-Agent')
def share_location(request, session_id):
    """位置情報共有ページ - セキュリティ強化版"""
    try:
        validate_session_id(session_id)
    except ValidationError:
        raise Http404("セッションが見つかりません")
    
    session = get_object_or_404(LocationSession, session_id=session_id)
    
    if session.is_expired():
        return render(request, 'tracker/expired.html', {'session': session})
    
    # 参加者IDをセッションで管理（セキュア）
    participant_key = f'participant_{session_id}'
    participant_id = request.session.get(participant_key)
    
    if not participant_id:
        participant_id = str(uuid.uuid4())
        request.session[participant_key] = participant_id
        # セッションを保存
        request.session.save()
    
    # WebSocket用の設定
    is_secure = request.is_secure()
    ws_scheme = 'wss' if is_secure else 'ws'
    host = request.get_host()
    
    context = {
        'session': session,
        'participant_id': participant_id,
        'expires_at': session.expires_at,
        'websocket_url': f'{ws_scheme}://{host}/ws/location/{session_id}/',
        'csrf_token': get_token(request),
        'nonce': get_random_string(16),  # CSP用nonce
    }
    return render(request, 'tracker/share.html', context)

# WebSocket通知用のヘルパー関数
def notify_location_update(session_id, locations_data):
    """WebSocketで位置情報更新を全参加者に通知"""
    try:
        validate_session_id(session_id)
        channel_layer = get_channel_layer()
        if channel_layer:
            async_to_sync(channel_layer.group_send)(
                f'location_{session_id}',
                {
                    'type': 'location_broadcast',
                    'locations': locations_data
                }
            )
    except ValidationError:
        logger.error(f'Invalid session_id in notify_location_update: {session_id}')

def get_all_locations_data(session):
    """セッション内の全位置情報を取得"""
    locations = LocationData.objects.filter(session=session, is_active=True)
    return [
        {
            'participant_id': str(location.participant_id),  # str()で明示的に変換
            'participant_name': escape(location.participant_name or f'参加者{str(location.participant_id)[:8]}'),  # str()で明示的に変換
            'latitude': float(location.latitude) if location.latitude else None,
            'longitude': float(location.longitude) if location.longitude else None,
            'accuracy': float(location.accuracy) if location.accuracy else None,
            'last_updated': location.last_updated.isoformat(),
            'is_background': location.is_background,
        }
        for location in locations
    ]

@csrf_exempt  # WebSocketからのHTTP fallback用
@require_http_methods(["POST"])
def api_update_location(request, session_id):
    """位置情報更新API - セキュリティ強化版"""
    # レート制限チェック
    if not rate_limit_check(request, 'update_location'):
        return JsonResponse({'error': 'リクエスト制限に達しました'}, status=429)
    
    try:
        validate_session_id(session_id)
    except ValidationError:
        return JsonResponse({'error': '無効なセッションIDです'}, status=400)
    
    session = get_object_or_404(LocationSession, session_id=session_id)
    
    if session.is_expired():
        return JsonResponse({'error': 'セッションが期限切れです'}, status=400)
    
    try:
        data = json.loads(request.body)
        
        participant_id = data.get('participant_id')
        latitude = data.get('latitude')
        longitude = data.get('longitude')
        accuracy = data.get('accuracy')
        participant_name = data.get('participant_name', '')
        is_background = bool(data.get('is_background', False))
        
        # バリデーション
        validate_participant_id(participant_id)
        validate_participant_name(participant_name)
        lat, lng = validate_coordinates(latitude, longitude)
        
        # 精度の検証
        if accuracy is not None:
            try:
                accuracy = float(accuracy)
                if accuracy < 0 or accuracy > 10000:  # 10km以内
                    accuracy = None
            except (TypeError, ValueError):
                accuracy = None
        
        # 位置情報を更新または作成
        location, created = LocationData.objects.update_or_create(
            session=session,
            participant_id=participant_id,
            defaults={
                'latitude': lat,
                'longitude': lng,
                'accuracy': accuracy,
                'participant_name': bleach.clean(participant_name, tags=[], strip=True)[:MAX_PARTICIPANT_NAME_LENGTH],
                'is_background': is_background,
                'is_active': True,
            }
        )
        
        # 初回参加のログ記録
        if created:
            SessionLog.objects.create(
                session=session,
                action='joined',
                participant_id=participant_id,
                ip_address=get_client_ip(request),
                user_agent=request.META.get('HTTP_USER_AGENT', '')[:500]
            )
        
        # WebSocketで全参加者に通知
        locations_data = get_all_locations_data(session)
        notify_location_update(session_id, locations_data)
        
        return JsonResponse({'success': True, 'message': '位置情報を更新しました'})
        
    except json.JSONDecodeError:
        return JsonResponse({'error': '無効なJSONデータです'}, status=400)
    except ValidationError as e:
        return JsonResponse({'error': str(e)}, status=400)
    except Exception as e:
        logger.error(f'Location update error: {str(e)}')
        return JsonResponse({'error': '位置情報の更新に失敗しました'}, status=500)

@require_http_methods(["GET"])
@never_cache
def api_get_locations(request, session_id):
    """セッション内の全位置情報取得API - セキュリティ強化版"""
    try:
        validate_session_id(session_id)
    except ValidationError:
        return JsonResponse({'error': '無効なセッションIDです'}, status=400)
    
    session = get_object_or_404(LocationSession, session_id=session_id)
    
    if session.is_expired():
        return JsonResponse({'error': 'セッションが期限切れです'}, status=400)
    
    locations_data = get_all_locations_data(session)
    
    return JsonResponse({
        'locations': locations_data,
        'expires_at': session.expires_at.isoformat(),
        'is_expired': session.is_expired(),
    })

@csrf_exempt
@require_http_methods(["POST"])
def api_leave_session(request, session_id):
    """セッションから退出API - セキュリティ強化版"""
    try:
        validate_session_id(session_id)
    except ValidationError:
        return JsonResponse({'error': '無効なセッションIDです'}, status=400)
    
    session = get_object_or_404(LocationSession, session_id=session_id)
    
    try:
        data = json.loads(request.body)
        participant_id = data.get('participant_id')
        
        validate_participant_id(participant_id)
        
        # 位置情報を非アクティブに設定
        LocationData.objects.filter(
            session=session, 
            participant_id=participant_id
        ).update(is_active=False)
        
        # ログ記録
        SessionLog.objects.create(
            session=session,
            action='left',
            participant_id=participant_id,
            ip_address=get_client_ip(request),
            user_agent=request.META.get('HTTP_USER_AGENT', '')[:500]
        )
        
        # WebSocketで全参加者に通知
        locations_data = get_all_locations_data(session)
        notify_location_update(session_id, locations_data)
        
        return JsonResponse({'success': True, 'message': 'セッションから退出しました'})
        
    except json.JSONDecodeError:
        return JsonResponse({'error': '無効なJSONデータです'}, status=400)
    except ValidationError as e:
        return JsonResponse({'error': str(e)}, status=400)
    except Exception as e:
        logger.error(f'Leave session error: {str(e)}')
        return JsonResponse({'error': 'セッション退出に失敗しました'}, status=500)

def get_client_ip(request):
    """クライアントのIPアドレスを取得 - セキュリティ強化版"""
    # X-Forwarded-Forヘッダーから取得（プロキシ経由の場合）
    x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded_for:
        # 最初のIPアドレスを取得（信頼できるプロキシの場合）
        ip = x_forwarded_for.split(',')[0].strip()
        # IPアドレスの妥当性をチェック
        if re.match(r'^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$', ip):
            return ip
    
    # X-Real-IPヘッダーから取得
    x_real_ip = request.META.get('HTTP_X_REAL_IP')
    if x_real_ip and re.match(r'^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$', x_real_ip):
        return x_real_ip
    
    # 直接のIPアドレス
    return request.META.get('REMOTE_ADDR', '127.0.0.1')

# views.pyに追加する不足している関数

@csrf_exempt
@require_http_methods(["POST"])
def api_offline_status(request, session_id):
    """参加者のオフライン状態更新API - セキュリティ強化版"""
    # レート制限チェック
    if not rate_limit_check(request, 'offline_status'):
        return JsonResponse({'error': 'リクエスト制限に達しました'}, status=429)
    
    try:
        validate_session_id(session_id)
    except ValidationError:
        return JsonResponse({'error': '無効なセッションIDです'}, status=400)
    
    session = get_object_or_404(LocationSession, session_id=session_id)
    
    if session.is_expired():
        return JsonResponse({'error': 'セッションが期限切れです'}, status=400)
    
    try:
        data = json.loads(request.body)
        
        participant_id = data.get('participant_id')
        participant_name = data.get('participant_name', '')
        
        # バリデーション
        validate_participant_id(participant_id)
        validate_participant_name(participant_name)
        
        # 参加者をオフライン状態に更新
        LocationData.objects.filter(
            session=session,
            participant_id=participant_id
        ).update(
            is_online=False,
            status='offline',
            participant_name=bleach.clean(participant_name, tags=[], strip=True)[:MAX_PARTICIPANT_NAME_LENGTH],
            last_updated=timezone.now()
        )
        
        # ログ記録
        SessionLog.objects.create(
            session=session,
            action='offline',
            participant_id=participant_id,
            ip_address=get_client_ip(request),
            user_agent=request.META.get('HTTP_USER_AGENT', '')[:500]
        )
        
        # WebSocketで全参加者に通知
        locations_data = get_all_locations_data(session)
        notify_location_update(session_id, locations_data)
        
        return JsonResponse({'success': True, 'message': 'オフライン状態に更新しました'})
        
    except json.JSONDecodeError:
        return JsonResponse({'error': '無効なJSONデータです'}, status=400)
    except ValidationError as e:
        return JsonResponse({'error': str(e)}, status=400)
    except Exception as e:
        logger.error(f'Offline status update error: {str(e)}')
        return JsonResponse({'error': 'オフライン状態の更新に失敗しました'}, status=500)


@csrf_exempt  
@require_http_methods(["POST"])
def api_update_name(request, session_id):
    """参加者名更新API - セキュリティ強化版"""
    # レート制限チェック
    if not rate_limit_check(request, 'update_name'):
        return JsonResponse({'error': 'リクエスト制限に達しました'}, status=429)
    
    try:
        validate_session_id(session_id)
    except ValidationError:
        return JsonResponse({'error': '無効なセッションIDです'}, status=400)
    
    session = get_object_or_404(LocationSession, session_id=session_id)
    
    if session.is_expired():
        return JsonResponse({'error': 'セッションが期限切れです'}, status=400)
    
    try:
        data = json.loads(request.body)
        
        participant_id = data.get('participant_id')
        participant_name = data.get('participant_name', '')
        
        # バリデーション
        validate_participant_id(participant_id)
        validate_participant_name(participant_name)
        
        # 参加者名を更新
        LocationData.objects.filter(
            session=session,
            participant_id=participant_id
        ).update(
            participant_name=bleach.clean(participant_name, tags=[], strip=True)[:MAX_PARTICIPANT_NAME_LENGTH],
            last_updated=timezone.now()
        )
        
        # WebSocketで全参加者に通知
        locations_data = get_all_locations_data(session)
        notify_location_update(session_id, locations_data)
        
        return JsonResponse({'success': True, 'message': '参加者名を更新しました'})
        
    except json.JSONDecodeError:
        return JsonResponse({'error': '無効なJSONデータです'}, status=400)
    except ValidationError as e:
        return JsonResponse({'error': str(e)}, status=400)
    except Exception as e:
        logger.error(f'Name update error: {str(e)}')
        return JsonResponse({'error': '参加者名の更新に失敗しました'}, status=500)


@require_http_methods(["GET"])
@never_cache
def api_session_status(request, session_id):
    """セッション状態取得API - セキュリティ強化版"""
    try:
        validate_session_id(session_id)
    except ValidationError:
        return JsonResponse({'error': '無効なセッションIDです'}, status=400)
    
    session = get_object_or_404(LocationSession, session_id=session_id)
    
    return JsonResponse({
        'session_id': str(session.session_id),  # str()で明示的に変換
        'is_expired': session.is_expired(),
        'expires_at': session.expires_at.isoformat(),
        'duration_minutes': session.duration_minutes,
        'created_at': session.created_at.isoformat(),
        'participant_count': LocationData.objects.filter(
            session=session, 
            is_active=True
        ).count()
    })


@csrf_exempt
@require_http_methods(["POST"])
def api_ping(request, session_id):
    """参加者の生存確認API - セキュリティ強化版"""
    # レート制限チェック（pingは頻繁に呼ばれるため、制限を緩く設定）
    if not rate_limit_check(request, 'ping'):
        return JsonResponse({'error': 'リクエスト制限に達しました'}, status=429)
    
    try:
        validate_session_id(session_id)
    except ValidationError:
        return JsonResponse({'error': '無効なセッションIDです'}, status=400)
    
    session = get_object_or_404(LocationSession, session_id=session_id)
    
    if session.is_expired():
        return JsonResponse({'error': 'セッションが期限切れです'}, status=400)
    
    try:
        data = json.loads(request.body)
        
        participant_id = data.get('participant_id')
        timestamp = data.get('timestamp')
        
        # バリデーション
        validate_participant_id(participant_id)
        
        # 最終更新時刻を更新
        LocationData.objects.filter(
            session=session,
            participant_id=participant_id
        ).update(
            last_updated=timezone.now(),
            is_online=True
        )
        
        return JsonResponse({
            'success': True,
            'pong': True,
            'timestamp': timestamp,
            'server_time': timezone.now().isoformat()
        })
        
    except json.JSONDecodeError:
        return JsonResponse({'error': '無効なJSONデータです'}, status=400)
    except ValidationError as e:
        return JsonResponse({'error': str(e)}, status=400)
    except Exception as e:
        logger.error(f'Ping error: {str(e)}')
        return JsonResponse({'error': 'Ping処理に失敗しました'}, status=500)


@csrf_exempt
@require_http_methods(["POST"])
def api_stop_sharing(request, session_id):
    """位置情報共有停止API - セキュリティ強化版"""
    # レート制限チェック
    if not rate_limit_check(request, 'stop_sharing'):
        return JsonResponse({'error': 'リクエスト制限に達しました'}, status=429)
    
    try:
        validate_session_id(session_id)
    except ValidationError:
        return JsonResponse({'error': '無効なセッションIDです'}, status=400)
    
    session = get_object_or_404(LocationSession, session_id=session_id)
    
    if session.is_expired():
        return JsonResponse({'error': 'セッションが期限切れです'}, status=400)
    
    try:
        data = json.loads(request.body)
        
        participant_id = data.get('participant_id')
        participant_name = data.get('participant_name', '')
        
        # バリデーション
        validate_participant_id(participant_id)
        validate_participant_name(participant_name)
        
        # 位置情報を削除して待機状態に変更
        LocationData.objects.filter(
            session=session,
            participant_id=participant_id
        ).update(
            latitude=None,
            longitude=None,
            accuracy=None,
            status='waiting',
            is_online=True,
            participant_name=bleach.clean(participant_name, tags=[], strip=True)[:MAX_PARTICIPANT_NAME_LENGTH],
            last_updated=timezone.now()
        )
        
        # ログ記録
        SessionLog.objects.create(
            session=session,
            action='stopped_sharing',
            participant_id=participant_id,
            ip_address=get_client_ip(request),
            user_agent=request.META.get('HTTP_USER_AGENT', '')[:500]
        )
        
        # WebSocketで全参加者に通知
        locations_data = get_all_locations_data(session)
        notify_location_update(session_id, locations_data)
        
        return JsonResponse({'success': True, 'message': '位置情報の共有を停止しました'})
        
    except json.JSONDecodeError:
        return JsonResponse({'error': '無効なJSONデータです'}, status=400)
    except ValidationError as e:
        return JsonResponse({'error': str(e)}, status=400)
    except Exception as e:
        logger.error(f'Stop sharing error: {str(e)}')
        return JsonResponse({'error': '共有停止処理に失敗しました'}, status=500)


# 既存のrate_limit_check関数を改良版に置き換え
def rate_limit_check(request, key_suffix='', limit=MAX_REQUESTS_PER_MINUTE):
    """レート制限チェック（改良版）"""
    from django.core.cache import cache
    
    client_ip = get_client_ip(request)
    cache_key = f'rate_limit_{client_ip}_{key_suffix}'
    
    # pingの場合は制限を緩くする
    if key_suffix == 'ping':
        limit = MAX_REQUESTS_PER_MINUTE * 3  # 3倍まで許可
    
    requests = cache.get(cache_key, 0)
    if requests >= limit:
        logger.warning(f'Rate limit exceeded for {client_ip}, key: {key_suffix}')
        return False
    
    cache.set(cache_key, requests + 1, 60)  # 1分間
    return True


# セキュリティ強化: 不正なリクエストを検出する関数
def detect_suspicious_activity(request, participant_id=None):
    """不審なアクティビティを検出"""
    client_ip = get_client_ip(request)
    user_agent = request.META.get('HTTP_USER_AGENT', '')
    
    # 不審なUser-Agentをチェック
    suspicious_agents = ['bot', 'crawler', 'spider', 'scraper']
    if any(agent in user_agent.lower() for agent in suspicious_agents):
        logger.warning(f'Suspicious user agent detected: {user_agent} from {client_ip}')
        return True
    
    # 短時間での大量リクエストをチェック
    from django.core.cache import cache
    
    if participant_id:
        cache_key = f'activity_{client_ip}_{participant_id}'
    else:
        cache_key = f'activity_{client_ip}'
    
    activity_count = cache.get(cache_key, 0)
    if activity_count > 50:  # 1分間に50回以上
        logger.warning(f'High activity detected for {client_ip}: {activity_count} requests')
        return True
    
    cache.set(cache_key, activity_count + 1, 60)
    return False


@require_http_methods(["GET"])
@never_cache
def api_get_stats(request):
    """統計情報取得API"""
    try:
        # アクティブなセッション数を取得
        active_sessions_count = LocationSession.objects.filter(
            expires_at__gt=timezone.now()
        ).count()
        
        # 現在の同時接続人数を取得（過去5分以内にアクティブな参加者）
        five_minutes_ago = timezone.now() - timedelta(minutes=5)
        online_participants_count = LocationData.objects.filter(
            session__expires_at__gt=timezone.now(),
            is_active=True,
            is_online=True,
            last_updated__gte=five_minutes_ago
        ).count()
        
        return JsonResponse({
            'success': True,
            'active_sessions_count': active_sessions_count,
            'online_participants_count': online_participants_count,
            'timestamp': timezone.now().isoformat()
        })
        
    except Exception as e:
        logger.error(f'Error fetching statistics: {str(e)}')
        return JsonResponse({
            'success': False,
            'error': '統計情報の取得に失敗しました',
            'active_sessions_count': 0,
            'online_participants_count': 0
        }, status=500)
    
    # views.py に以下の関数を追加

@never_cache
def privacy(request):
    """プライバシーポリシーページ"""
    context = {
        'nonce': get_random_string(16),  # CSP用nonce
    }
    return render(request, 'tracker/privacy.html', context)