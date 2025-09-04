# tracker/consumers.py - リファクタリング版（完全版）
import json
import logging
import re
import threading
import time
import uuid
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, List
from django.db.models import Count
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.utils import timezone
from django.core.exceptions import ValidationError
from django.utils.html import escape
from django.core.cache import cache
from django.db.models import Q
from .models import LocationSession, LocationData, ChatMessage, ChatUnreadCount

logger = logging.getLogger(__name__)

# 定数
class Config:
    MAX_PARTICIPANT_NAME_LENGTH = 30
    MAX_MESSAGE_LENGTH = 200
    MAX_WEBSOCKET_MESSAGE_SIZE = 4096
    MAX_MESSAGES_PER_MINUTE = 100
    MAX_CONNECTIONS_PER_SESSION = 20
    DESKTOP_OFFLINE_DELAY = 120  # 2分
    MOBILE_OFFLINE_DELAY = 300   # 5分
    STAY_DISTANCE_THRESHOLD = 30  # ★ 30mに変更：滞在地点判定の閾値（メートル）
    ALLOWED_MESSAGE_TYPES = [
        'join', 'location_update', 'name_update', 'background_status_update',
        'immediate_foreground_return',
        'stop_sharing', 'sync_status', 'offline', 'leave', 'ping', 'notification',
        'chat_message', 'typing_indicator',
        'request_chat_history',
        'mark_as_read',
        'stay_reset',
        'stay_time_update',
        'single_participant_update'  # ★ 追加
    ]
    ALLOWED_STATUSES = ['waiting', 'sharing', 'stopped']
    ALLOWED_NOTIFICATION_TYPES = ['info', 'success', 'warning', 'danger', 'secondary']


class LocationConsumer(AsyncWebsocketConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.session_id: Optional[str] = None
        self.room_group_name: Optional[str] = None
        self.participant_id: Optional[str] = None
        self.client_ip: Optional[str] = None
        self.is_mobile: bool = False
        self.message_count: int = 0
        self.last_message_time = timezone.now()

    async def connect(self):
        """WebSocket接続処理"""
        try:
            self.session_id = self.scope['url_route']['kwargs']['session_id']
            self.room_group_name = f'location_{self.session_id}'
            self.client_ip = self._get_client_ip()

            # 事前検証
            if not self._validate_session_id(self.session_id):
                logger.warning(f"Invalid session_id: {self.session_id} from {self.client_ip}")
                await self.close(code=4000)
                return

            if not await self._check_session_exists():
                logger.warning(f"Session not found: {self.session_id}")
                await self.close(code=4404)
                return

            if not await self._check_connection_limit():
                logger.warning(f"Connection limit exceeded: {self.session_id}")
                await self.close(code=4429)
                return

            # 既存参加者チェック
            existing_participant = await self._get_participant_by_ip()
            if existing_participant:
                self.participant_id = existing_participant['participant_id']

            # グループ参加
            await self.channel_layer.group_add(self.room_group_name, self.channel_name)
            await self.accept()
            
            logger.info(f"WebSocket connected: {self.session_id} from {self.client_ip}")

        except Exception as e:
            logger.error(f"Connection error: {str(e)}")
            await self.close(code=4500)

    async def disconnect(self, close_code):
        """WebSocket切断処理（退出時の完全削除対応版）"""
        if self.participant_id:
            try:
                # 退出処理の場合は参加者を完全削除
                if close_code == 1000 and hasattr(self, '_is_leaving') and self._is_leaving:
                    logger.info(f"User leaving disconnect: {self.participant_id}")
                    # 退出の場合は完全削除
                    await self._completely_remove_participant(self.participant_id)
                    await self._broadcast_locations()
                    # グループ退出
                    if self.room_group_name:
                        await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
                    return
                
                # 現在の参加者情報を取得して名前を保持
                current_participant = await self._get_current_participant_info()
                participant_name = current_participant.get('participant_name', '') if current_participant else ''
                
                # 切断タイプに応じた処理
                if close_code == 1000:  # 正常終了（ページ閉じ）
                    logger.info(f"Normal disconnect (page close): {self.participant_id}")
                    # ページ閉じの場合は名前を保持してバックグラウンド状態に設定
                    await self._update_participant_status(
                        self.participant_id, participant_name,
                        is_online=True,
                        is_background=True,
                        page_unloading=True,
                        immediate_update=True,
                        preserve_name=True
                    )
                    await self._broadcast_locations()
                    
                    # その後遅延オフライン処理を開始
                    await self._handle_page_close_disconnect()
                else:  # 異常終了
                    logger.info(f"Abnormal disconnect: {self.participant_id} (code: {close_code})")
                    # 異常終了でも名前は保持してバックグラウンド状態に移行
                    await self._update_participant_status(
                        self.participant_id, participant_name,
                        is_online=True,
                        is_background=True,
                        immediate_update=True,
                        preserve_name=True
                    )
                    await self._broadcast_locations()
                    
                    delay = Config.MOBILE_OFFLINE_DELAY if self.is_mobile else Config.DESKTOP_OFFLINE_DELAY
                    await self._schedule_delayed_offline(delay)

            except Exception as e:
                logger.error(f"Disconnect error for {self.participant_id}: {str(e)}")

        # グループ退出
        if self.room_group_name:
            await self.channel_layer.group_discard(self.room_group_name, self.channel_name)

    # === ：現在の参加者情報取得メソッド ===
    @database_sync_to_async
    def _get_current_participant_info(self) -> Optional[Dict[str, Any]]:
        """現在の参加者情報を取得（名前保持用）"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            participant = LocationData.objects.filter(
                session=session,
                participant_id=self.participant_id,
                is_active=True
            ).first()
            
            if participant:
                return {
                    'participant_id': participant.participant_id,
                    'participant_name': participant.participant_name,
                    'status': participant.status,
                    'is_background': participant.is_background,
                    'is_online': participant.is_online
                }
            return None
        except Exception as e:
            logger.error(f"Get current participant info error: {str(e)}")
            return None
        

    async def receive(self, text_data):
        """メッセージ受信処理"""
        # サイズ・レートチェック
        if len(text_data) > Config.MAX_WEBSOCKET_MESSAGE_SIZE:
            await self.close(code=4413)
            return

        if not await self._check_rate_limit():
            await self.close(code=4429)
            return

        try:
            data = json.loads(text_data)
            message_type = data.get('type')

            if message_type not in Config.ALLOWED_MESSAGE_TYPES:
                await self._send_error("無効なメッセージタイプです")
                return

            # ハンドラー実行
            await self._dispatch_message(message_type, data)

        except json.JSONDecodeError:
            await self._send_error("無効なJSONフォーマットです")
        except Exception as e:
            logger.error(f"Message processing error: {str(e)}")
            await self._send_error("メッセージ処理中にエラーが発生しました")

    # === メッセージハンドラー ===

    async def _dispatch_message(self, message_type: str, data: Dict[str, Any]):
        """メッセージタイプに応じたハンドラーを実行"""
        handlers = {
            'join': self._handle_join,
            'location_update': self._handle_location_update,
            'name_update': self._handle_name_update,
            'background_status_update': self._handle_background_status_update,
            'immediate_foreground_return': self._handle_immediate_foreground_return,
            'stop_sharing': self._handle_stop_sharing,
            'sync_status': self._handle_sync_status,
            'offline': self._handle_offline,
            'leave': self._handle_leave,
            'ping': self._handle_ping,
            'notification': self._handle_notification,
            'chat_message': self._handle_chat_message,
            'typing_indicator': self._handle_typing_indicator,
            'request_chat_history': self._handle_chat_history_request,
            'mark_as_read': self._handle_mark_as_read,
            # ★ 
            'stay_reset': self._handle_stay_reset,
            'stay_time_update': self._handle_stay_time_update,
            'single_participant_update': self._handle_single_participant_update,  # ★ 追加
        }

        handler = handlers.get(message_type)
        if handler:
            await handler(data)

    async def _handle_single_participant_update(self, data: Dict[str, Any]):
        """特定参加者の位置更新処理（効率化版）"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            participant_name = self._sanitize_participant_name(data.get('participant_name', ''))
            latitude, longitude = self._validate_coordinates(data.get('latitude'), data.get('longitude'))
            accuracy = self._validate_accuracy(data.get('accuracy'))
            
            if not await self._check_session_valid():
                await self.send_json({'type': 'session_expired', 'message': 'Session has expired'})
                return
            
            # 位置情報を保存
            location_data = await self._save_location_data({
                'participant_id': participant_id,
                'participant_name': participant_name,
                'latitude': latitude,
                'longitude': longitude,
                'accuracy': accuracy,
                'is_background': bool(data.get('is_background', False)),
                'is_online': True,
                'status': 'sharing',
                'has_shared_before': True
            })
            
            # 単一参加者のデータのみをブロードキャスト
            await self._broadcast_single_participant(participant_id)
            
        except ValidationError as e:
            await self._send_error(str(e))

    async def _broadcast_single_participant(self, participant_id: str):
        """特定参加者のみのデータをブロードキャスト"""
        try:
            participant_data = await self._get_single_participant_data(participant_id)
            if participant_data:
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'single_participant_broadcast',
                        'participant_id': participant_id,
                        'participant_data': participant_data
                    }
                )
        except Exception as e:
            logger.error(f"Single participant broadcast error: {str(e)}")

    @database_sync_to_async
    def _get_single_participant_data(self, participant_id: str) -> Optional[Dict[str, Any]]:
        """特定参加者のデータのみを取得"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            loc = LocationData.objects.filter(
                session=session,
                participant_id=participant_id,
                is_active=True
            ).first()
            
            if not loc:
                return None
            
            has_location = (loc.latitude is not None and 
                        loc.longitude is not None and 
                        loc.latitude != 999.0 and 
                        loc.longitude != 999.0)
            
            # サーバー側で滞在時間を計算
            stay_minutes = 0
            if loc.stay_start_time and loc.is_online and loc.status == 'sharing':
                elapsed = (timezone.now() - loc.stay_start_time).total_seconds() / 60
                stay_minutes = int(elapsed)
            elif loc.total_stay_minutes:
                stay_minutes = loc.total_stay_minutes
            
            return {
                'participant_id': loc.participant_id,
                'participant_name': escape(loc.participant_name or f'参加者{loc.participant_id[:4]}'),
                'latitude': float(loc.latitude) if has_location else None,
                'longitude': float(loc.longitude) if has_location else None,
                'accuracy': float(loc.accuracy) if (has_location and loc.accuracy) else None,
                'last_updated': loc.last_updated.isoformat(),
                'last_seen_at': loc.last_seen_at.isoformat() if getattr(loc, 'last_seen_at', None) else None,
                'is_background': loc.is_background,
                'is_online': loc.is_online,
                'is_mobile': getattr(loc, 'is_mobile', False),
                'status': loc.status,
                'has_shared_before': getattr(loc, 'has_shared_before', False),
                'stay_minutes': stay_minutes,
            }
            
        except Exception as e:
            logger.error(f"Get single participant data error: {str(e)}")
            return None

    # グループメッセージハンドラーを追加
    async def single_participant_broadcast(self, event):
        """特定参加者のみの更新をブロードキャスト"""
        await self.send_json({
            'type': 'single_participant_update',
            'participant_id': event['participant_id'],
            'participant_data': event['participant_data']
        })


    async def _handle_stay_reset(self, data: Dict[str, Any]):
        """滞在地点リセット処理"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            
            await self._reset_stay_time(participant_id)
            
            # 他の参加者に通知
            await self._broadcast_locations()
            
        except Exception as e:
            logger.error(f"Stay reset error: {str(e)}")

    async def _handle_stay_time_update(self, data: Dict[str, Any]):
        """滞在時間更新処理（差分追加）"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            stay_minutes = int(data.get('stay_minutes', 0))
            
            await self._update_stay_time(participant_id, stay_minutes)
            
            # 他の参加者に通知
            await self._broadcast_locations()
            
        except Exception as e:
            logger.error(f"Stay time update error: {str(e)}")


    # _handle_chat_history_requestメソッドを修正
    async def _handle_chat_history_request(self, data: Dict[str, Any]):
        """チャット履歴要求処理（未読カウント付き）"""
        try:
            session_id = data.get('session_id')
            participant_id = self._validate_participant_id(data.get('participant_id'))
            
            # 履歴を取得
            history = await self._get_chat_history(session_id, participant_id)
            # 未読カウントを取得（participant_id を渡す）
            unread_counts = await self._get_unread_counts(session_id, participant_id)
            
            await self.send_json({
                'type': 'chat_history',
                'messages': history,
                'unread_counts': unread_counts
            })
            
        except Exception as e:
            logger.error(f"Chat history request error: {str(e)}")


    @database_sync_to_async
    def _reset_stay_time(self, participant_id: str):
        """滞在時間をリセット"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            LocationData.objects.filter(
                session=session,
                participant_id=participant_id
            ).update(
                stay_start_time=timezone.now(),
                total_stay_minutes=0
            )
            logger.info(f"滞在時間リセット: {participant_id}")
        except Exception as e:
            logger.error(f"Stay time reset error: {str(e)}")

    @database_sync_to_async
    def _update_stay_time(self, participant_id: str, additional_minutes: int):
        """滞在時間に差分を追加"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            location = LocationData.objects.filter(
                session=session,
                participant_id=participant_id
            ).first()
            
            if location:
                location.total_stay_minutes = (location.total_stay_minutes or 0) + additional_minutes
                location.save()
                logger.info(f"滞在時間更新: {participant_id} +{additional_minutes}分 (合計: {location.total_stay_minutes}分)")
        except Exception as e:
            logger.error(f"Stay time update error: {str(e)}")

    # 新しいハンドラーを追加
    async def _handle_mark_as_read(self, data: Dict[str, Any]):
        """既読マーク処理"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            chat_type = data.get('chat_type', 'group')
            sender_id = data.get('sender_id')  # 個別チャットの送信者
            
            # デバッグログ
            logger.info(f"Mark as read request: participant={participant_id}, type={chat_type}, sender={sender_id}")
            
            await self._mark_messages_as_read(participant_id, chat_type, sender_id)
            
        except Exception as e:
            logger.error(f"Mark as read error: {str(e)}")

    @database_sync_to_async
    def _mark_messages_as_read(self, participant_id: str, chat_type: str, sender_id: str = None):
        """メッセージを既読にマーク（改善版）"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            
            if chat_type == 'group':
                # 自分以外が送信したグループメッセージを既読に
                updated = ChatMessage.objects.filter(
                    session=session,
                    chat_type='group',
                    is_read=False
                ).exclude(sender_id=participant_id).update(
                    is_read=True
                )
                
                logger.info(f"Marked {updated} group messages as read for {participant_id}")
                
            elif chat_type == 'individual' and sender_id:
                # 特定の人からの個別メッセージを既読に
                updated = ChatMessage.objects.filter(
                    session=session,
                    chat_type='individual',
                    sender_id=sender_id,
                    target_id=participant_id,
                    is_read=False
                ).update(
                    is_read=True
                )
                
                logger.info(f"Marked {updated} individual messages as read from {sender_id} to {participant_id}")
            
            return True
            
        except Exception as e:
            logger.error(f"Database error in mark_as_read: {str(e)}")
            return False

    @database_sync_to_async
    def _get_chat_history(self, session_id: str, participant_id: str) -> Dict[str, Any]:
        """チャット履歴を取得（修正版）"""
        try:
            from datetime import timedelta
            cutoff_time = timezone.now() - timedelta(hours=24)
            
            session = LocationSession.objects.get(session_id=session_id)
            messages = ChatMessage.objects.filter(
                session=session,
                timestamp__gte=cutoff_time
            ).order_by('timestamp')
            
            result = {
                'group': [],
                'individual': {}
            }
            
            for msg in messages:
                # 自分が送信したメッセージは常に既読として扱う
                is_read_for_current_user = (
                    msg.is_read or 
                    msg.sender_id == participant_id
                )
                
                message_data = {
                    'sender_id': msg.sender_id,
                    'sender_name': msg.sender_name,
                    'text': msg.text,
                    'timestamp': msg.timestamp.isoformat(),
                    'target_id': msg.target_id,
                    'is_read': is_read_for_current_user  # 修正
                }
                
                if msg.chat_type == 'group':
                    result['group'].append(message_data)
                else:
                    # 個別メッセージの整理
                    if msg.target_id == participant_id:
                        # 自分宛のメッセージ
                        conversation_key = msg.sender_id
                    elif msg.sender_id == participant_id:
                        # 自分が送信したメッセージ
                        conversation_key = msg.target_id
                    else:
                        continue  # 関係ないメッセージはスキップ
                    
                    if conversation_key and conversation_key != participant_id:
                        if conversation_key not in result['individual']:
                            result['individual'][conversation_key] = []
                        result['individual'][conversation_key].append(message_data)
            
            return result
            
        except Exception as e:
            logger.error(f"Get chat history error: {str(e)}")
            return {'group': [], 'individual': {}}
    
    def _get_conversation_key(self, current_id: str, sender_id: str, target_id: str) -> str:
        """会話のキーを生成（修正版）"""
        if sender_id == current_id:
            return target_id
        elif target_id == current_id:
            return sender_id
        else:
            return None
    
    # 新しいハンドラーメソッドを追加
    async def _handle_chat_message(self, data: Dict[str, Any]):
        """チャットメッセージ処理"""
        try:
            chat_type = data.get('chat_type', 'group')
            sender_id = self._validate_participant_id(data.get('sender_id'))
            sender_name = self._sanitize_participant_name(data.get('sender_name', ''))
            
            if not sender_name or sender_name.strip() == '':
                sender_name = f'参加者{sender_id[:4]}'
            
            text = self._sanitize_message(data.get('text', ''))
            timestamp = data.get('timestamp', timezone.now().isoformat())
            
            if not text:
                await self._send_error("メッセージが空です")
                return
            
            # メッセージを保存（送信者自身のメッセージはis_read=Trueで保存）
            message_id = await self._save_chat_message_with_read_status({
                'session_id': self.session_id,
                'chat_type': chat_type,
                'sender_id': sender_id,
                'sender_name': sender_name,
                'target_id': data.get('target_id'),
                'text': text,
                'timestamp': timestamp,
                'is_read': False  # デフォルトは未読
            })
            
            # ブロードキャスト
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'chat_broadcast',
                    'chat_type': chat_type,
                    'sender_id': sender_id,
                    'sender_name': sender_name,
                    'target_id': data.get('target_id'),
                    'text': text,
                    'timestamp': timestamp
                }
            )
            
        except ValidationError as e:
            await self._send_error(str(e))


    @database_sync_to_async
    def _save_chat_message_with_read_status(self, data: Dict[str, Any]):
        """チャットメッセージを保存（既読状態付き）"""
        try:
            session = LocationSession.objects.get(session_id=data['session_id'])
            
            message = ChatMessage.objects.create(
                session=session,
                chat_type=data['chat_type'],
                sender_id=data['sender_id'],
                sender_name=data['sender_name'],
                target_id=data.get('target_id'),
                text=data['text'],
                timestamp=timezone.now(),
                is_read=data.get('is_read', False)
            )
            
            return message.id
            
        except Exception as e:
            logger.error(f"Chat message save error: {str(e)}")
            return None
    

    async def _handle_typing_indicator(self, data: Dict[str, Any]):
        """入力中インジケーター処理"""
        try:
            chat_type = data.get('chat_type', 'group')
            sender_id = self._validate_participant_id(data.get('sender_id'))
            sender_name = self._sanitize_participant_name(data.get('sender_name', ''))
            is_typing = bool(data.get('is_typing', False))
            
            # ブロードキャスト
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'typing_broadcast',
                    'chat_type': chat_type,
                    'sender_id': sender_id,
                    'sender_name': sender_name,
                    'target_id': data.get('target_id'),
                    'is_typing': is_typing
                }
            )
            
        except ValidationError as e:
            await self._send_error(str(e))

    # グループメッセージハンドラーを追加
    async def chat_broadcast(self, event):
        await self.send_json({
            'type': 'chat_message',
            'chat_type': event['chat_type'],
            'sender_id': event['sender_id'],
            'sender_name': event['sender_name'],
            'target_id': event.get('target_id'),
            'text': event['text'],
            'timestamp': event['timestamp']
        })

    async def typing_broadcast(self, event):
        await self.send_json({
            'type': 'typing_indicator',
            'chat_type': event['chat_type'],
            'sender_id': event['sender_id'],
            'sender_name': event['sender_name'],
            'target_id': event.get('target_id'),
            'is_typing': event['is_typing']
        })

    # データベース操作メソッドを追加
    @database_sync_to_async
    def _save_chat_message(self, data: Dict[str, Any]):
        """チャットメッセージを保存"""
        try:
            session = LocationSession.objects.get(session_id=data['session_id'])
            
            # メッセージを作成（デフォルトでis_read=False）
            message = ChatMessage.objects.create(
                session=session,
                chat_type=data['chat_type'],
                sender_id=data['sender_id'],
                sender_name=data['sender_name'],
                target_id=data.get('target_id'),
                text=data['text'],
                timestamp=timezone.now(),
                is_read=False  # 新規メッセージは未読
            )
            
            return message.id
            
        except Exception as e:
            logger.error(f"Chat message save error: {str(e)}")
            return None

    @database_sync_to_async
    def _get_unread_counts(self, session_id: str, participant_id: str) -> Dict[str, Any]:
        """未読カウントを取得（実際の未読メッセージ数をカウント）"""
        try:
            session = LocationSession.objects.get(session_id=session_id)
            
            logger.info(f"Getting unread counts for participant: {participant_id}")
            
            # グループメッセージの未読数をカウント
            # 自分が送信したメッセージと既読メッセージを除外
            group_messages = ChatMessage.objects.filter(
                session=session,
                chat_type='group',
                is_read=False
            ).exclude(
                sender_id=participant_id
            )
            group_unread = group_messages.count()
            
            logger.info(f"Group unread count: {group_unread}")
            
            # 個別メッセージの未読数をカウント
            individual_unread = {}
            
            # 自分宛の未読個別メッセージを取得
            individual_messages = ChatMessage.objects.filter(
                session=session,
                chat_type='individual',
                target_id=participant_id,
                is_read=False
            ).exclude(
                sender_id=participant_id
            )
            
            # 送信者ごとに未読数をカウント
            
            sender_counts = individual_messages.values('sender_id').annotate(
                unread_count=Count('id')
            )
            
            for item in sender_counts:
                individual_unread[item['sender_id']] = item['unread_count']
                logger.info(f"Individual unread from {item['sender_id']}: {item['unread_count']}")
            
            return {
                'group': group_unread,
                'individual': individual_unread
            }
            
        except Exception as e:
            logger.error(f"Get unread counts error: {str(e)}")
            return {'group': 0, 'individual': {}}

    @database_sync_to_async
    def _update_unread_count(self, participant_id: str, chat_type: str, 
                            sender_id: str = None, reset: bool = False):
        """未読カウントを更新"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            unread, created = ChatUnreadCount.objects.get_or_create(
                session=session,
                participant_id=participant_id,
                defaults={'group_unread': 0, 'individual_unread': {}}
            )
            
            if chat_type == 'group':
                if reset:
                    unread.group_unread = 0
                else:
                    unread.group_unread += 1
            elif sender_id:
                individual = unread.individual_unread or {}
                if reset:
                    individual[sender_id] = 0
                else:
                    individual[sender_id] = individual.get(sender_id, 0) + 1
                unread.individual_unread = individual
            
            unread.save()
            
        except Exception as e:
            logger.error(f"Update unread count error: {str(e)}")


    # ：即座フォアグラウンド復帰ハンドラー
    async def _handle_immediate_foreground_return(self, data: Dict[str, Any]):
        """即座フォアグラウンド復帰処理（最優先）"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            participant_name = self._sanitize_participant_name(data.get('participant_name', ''))
            is_sharing = bool(data.get('is_sharing', False))
            is_mobile = bool(data.get('is_mobile', False))
            page_returning = bool(data.get('page_returning', False))
            priority_update = bool(data.get('priority_update', False))

            self.is_mobile = is_mobile

            logger.info(f"=== 即座フォアグラウンド復帰開始: {participant_id} (sharing: {is_sharing}, mobile: {is_mobile}) ===")

            # 最優先でオンライン状態に復帰
            status = 'sharing' if is_sharing else 'waiting'
            await self._update_participant_status(
                participant_id, participant_name, 
                is_online=True,  # 確実にオンライン
                status=status, 
                is_background=False,  # 確実にフォアグラウンド
                immediate_update=True,
                priority_online=True,  # 最優先オンライン復帰フラグ
                page_returning=page_returning
            )
            
            # 即座にブロードキャスト（他の処理より優先）
            await self._broadcast_locations()
            
            # 確認レスポンス送信
            await self.send_json({
                'type': 'immediate_foreground_confirmed',
                'participant_id': participant_id,
                'is_online': True,
                'is_background': False,
                'status': status,
                'server_time': timezone.now().isoformat(),
                'message': 'フォアグラウンド復帰完了'
            })
            
            logger.info(f"=== 即座フォアグラウンド復帰完了: {participant_id} ===")

        except ValidationError as e:
            logger.error(f"Immediate foreground return validation error: {str(e)}")
            await self._send_error(str(e))
        except Exception as e:
            logger.error(f"Immediate foreground return error: {str(e)}")
            await self._send_error("フォアグラウンド復帰中にエラーが発生しました")

    async def _handle_join(self, data: Dict[str, Any]):
        """参加処理（重複防止強化版）"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            persistent_participant_id = self._validate_participant_id(data.get('persistent_participant_id', participant_id))
            participant_name = self._sanitize_participant_name(data.get('participant_name', ''))
            session_fingerprint = data.get('session_fingerprint', '')
            is_mobile = bool(data.get('is_mobile', False))
            is_background = bool(data.get('is_background', False))
            initial_status = data.get('initial_status', 'waiting')
            request_existing_check = bool(data.get('request_existing_check', False))
            immediate_online = bool(data.get('immediate_online', False))
            priority_connection = bool(data.get('priority_connection', False))
            page_returning = bool(data.get('page_returning', False))
            deduplicate = bool(data.get('deduplicate', False))  # ★ 追加

            self.is_mobile = is_mobile

            if initial_status not in Config.ALLOWED_STATUSES:
                initial_status = 'waiting'

            # 即座オンライン要求がある場合の処理
            if immediate_online or priority_connection:
                logger.info(f"即座オンライン要求: {participant_id} (priority: {priority_connection})")
                is_background = False

            # ★ 追加：重複防止処理
            if deduplicate:
                await self._cleanup_duplicate_entries(participant_id, persistent_participant_id)

            if request_existing_check:
                # 複数の方法で既存参加者を検索
                existing_participant = await self._find_existing_participant(
                    participant_id, persistent_participant_id, session_fingerprint
                )
                
                if existing_participant:
                    self.participant_id = existing_participant['participant_id']
                    ip_changed = existing_participant.get('ip_changed', False)
                    
                    # ★ 重要：既存参加者の場合は更新のみ（新規作成しない）
                    await self._update_existing_participant(
                        self.participant_id, 
                        existing_participant['participant_name'] or participant_name,
                        is_online=True,
                        status=initial_status,
                        is_background=is_background,
                        immediate_update=immediate_online,
                        priority_online=priority_connection,
                        page_returning=page_returning,
                        update_ip=True
                    )
                    
                    await self.send_json({
                        'type': 'participant_confirmed',
                        'participant_id': self.participant_id,
                        'is_existing': True,
                        'participant_name': existing_participant['participant_name'],
                        'immediate_online': immediate_online,
                        'is_background': is_background,
                        'ip_changed': ip_changed
                    })
                else:
                    self.participant_id = participant_id
                    
                    # ★ 新規参加者作成前に再度重複チェック
                    if not await self._check_participant_exists(participant_id):
                        await self._update_participant_status(
                            self.participant_id, participant_name,
                            is_online=True,
                            status='waiting',
                            is_background=is_background,
                            immediate_update=immediate_online,
                            priority_online=priority_connection,
                            page_returning=page_returning,
                            persistent_id=persistent_participant_id,
                            session_fingerprint=session_fingerprint
                        )
                    else:
                        # ★ 既に存在する場合は更新のみ
                        await self._update_existing_participant(
                            self.participant_id, participant_name,
                            is_online=True,
                            status='waiting',
                            is_background=is_background,
                            immediate_update=immediate_online,
                            priority_online=priority_connection,
                            page_returning=page_returning
                        )
                    
                    await self.send_json({
                        'type': 'participant_confirmed',
                        'participant_id': self.participant_id,
                        'is_existing': False,
                        'immediate_online': immediate_online,
                        'is_background': is_background,
                        'ip_changed': False
                    })
            else:
                # 旧形式対応
                self.participant_id = participant_id
                status = 'sharing' if data.get('is_sharing') else 'waiting'
                
                # ★ 既存チェック
                if await self._check_participant_exists(participant_id):
                    await self._update_existing_participant(
                        self.participant_id, participant_name,
                        is_online=True,
                        status=status,
                        is_background=is_background
                    )
                else:
                    await self._update_participant_status(
                        self.participant_id, participant_name,
                        is_online=True,
                        status=status,
                        is_background=is_background,
                        immediate_update=immediate_online,
                        priority_online=priority_connection,
                        persistent_id=persistent_participant_id,
                        session_fingerprint=session_fingerprint
                    )

            await self._broadcast_locations()

        except ValidationError as e:
            await self._send_error(str(e))

    @database_sync_to_async
    def _cleanup_duplicate_entries(self, participant_id: str, persistent_participant_id: str):
        """重複エントリのクリーンアップ"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            
            # 同じ participant_id または persistent_participant_id の重複を削除
            duplicates = LocationData.objects.filter(
                Q(session=session) & 
                (Q(participant_id=participant_id) | Q(persistent_participant_id=persistent_participant_id))
            ).order_by('last_updated')
            
            if duplicates.count() > 1:
                # 最新のものを残して他を非アクティブ化
                to_deactivate = list(duplicates)[:-1]
                for dup in to_deactivate:
                    dup.is_active = False
                    dup.save()
                logger.info(f"重複エントリをクリーンアップ: {len(to_deactivate)}件")
                
        except Exception as e:
            logger.error(f"Duplicate cleanup error: {str(e)}")

    @database_sync_to_async
    def _check_participant_exists(self, participant_id: str) -> bool:
        """参加者の存在確認"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            return LocationData.objects.filter(
                session=session,
                participant_id=participant_id,
                is_active=True
            ).exists()
        except Exception:
            return False

    @database_sync_to_async
    def _update_existing_participant(self, participant_id: str, participant_name: str,
                                    is_online: bool = True, status: str = None,
                                    is_background: bool = False, **kwargs):
        """既存参加者の更新のみ（新規作成しない）"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            location = LocationData.objects.filter(
                session=session,
                participant_id=participant_id,
                is_active=True
            ).first()
            
            if location:
                location.participant_name = participant_name or location.participant_name
                location.is_online = is_online
                location.is_background = is_background
                if status:
                    location.status = status
                location.last_updated = timezone.now()
                location.last_seen_at = timezone.now()
                location.save()
                logger.info(f"既存参加者を更新: {participant_id}")
            else:
                logger.warning(f"更新対象の参加者が見つかりません: {participant_id}")
                
        except Exception as e:
            logger.error(f"Update existing participant error: {str(e)}")

    # === ：既存参加者検索メソッド ===
    @database_sync_to_async
    def _find_existing_participant(self, participant_id: str, persistent_participant_id: str, 
                             session_fingerprint: str) -> Optional[Dict[str, Any]]:
        """既存参加者を複数の方法で検索（名前重複チェック追加）"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            cutoff_time = timezone.now() - timedelta(days=7)

            participant = None
            ip_changed = False

            # 1. participant_id での検索
            if participant_id:
                participant = LocationData.objects.filter(
                    session=session,
                    participant_id=participant_id,
                    first_seen__gte=cutoff_time,
                    is_active=True
                ).order_by('-last_updated').first()

                if participant and participant.ip_address != self.client_ip:
                    ip_changed = True

            # 2. persistent_participant_id での検索
            if not participant and persistent_participant_id:
                try:
                    participant = LocationData.objects.filter(
                        session=session,
                        persistent_participant_id=persistent_participant_id,
                        first_seen__gte=cutoff_time,
                        is_active=True
                    ).order_by('-last_updated').first()

                    if participant:
                        ip_changed = participant.ip_address != self.client_ip
                        logger.info(f"Found participant by persistent_id: {persistent_participant_id}, IP changed: {ip_changed}")
                except AttributeError:
                    pass

            # 3. session_fingerprint での検索
            if not participant and session_fingerprint:
                try:
                    participant = LocationData.objects.filter(
                        session=session,
                        session_fingerprint=session_fingerprint,
                        first_seen__gte=cutoff_time,
                        is_active=True
                    ).order_by('-last_updated').first()

                    if participant:
                        ip_changed = participant.ip_address != self.client_ip
                        logger.info(f"Found participant by fingerprint: {session_fingerprint}, IP changed: {ip_changed}")
                except AttributeError:
                    pass

            # 4. IP アドレスでの検索（フォールバック）
            if not participant:
                participant = LocationData.objects.filter(
                    session=session,
                    ip_address=self.client_ip,
                    first_seen__gte=cutoff_time,
                    is_active=True
                ).order_by('-last_updated').first()

                if participant:
                    logger.info(f"Found participant by IP address: {self.client_ip}")

            # ★ 追加：既存参加者が見つかった場合、古いオフライン状態のエントリをクリーンアップ
            if participant:
                # 同じセッションの同じ名前のオフライン参加者を非アクティブ化
                old_offline_participants = LocationData.objects.filter(
                    session=session,
                    participant_name=participant.participant_name,
                    is_online=False,
                    is_active=True
                ).exclude(participant_id=participant.participant_id)
                
                if old_offline_participants.exists():
                    old_count = old_offline_participants.count()
                    old_offline_participants.update(is_active=False)
                    logger.info(f"古いオフライン参加者を非アクティブ化: {old_count}件")

                return {
                    'participant_id': participant.participant_id,
                    'participant_name': participant.participant_name,
                    'is_existing': True,
                    'ip_changed': ip_changed
                }
            
            return None

        except Exception as e:
            logger.error(f"Existing participant lookup error: {str(e)}")
            return None
        
    async def _handle_location_update(self, data: Dict[str, Any]):
        """位置情報更新処理"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            participant_name = self._sanitize_participant_name(data.get('participant_name', ''))
            latitude, longitude = self._validate_coordinates(data.get('latitude'), data.get('longitude'))
            accuracy = self._validate_accuracy(data.get('accuracy'))

            if not await self._check_session_valid():
                await self.send_json({'type': 'session_expired', 'message': 'Session has expired'})
                return

            await self._save_location_data({
                'participant_id': participant_id,
                'participant_name': participant_name,
                'latitude': latitude,
                'longitude': longitude,
                'accuracy': accuracy,
                'is_background': bool(data.get('is_background', False)),
                'is_online': True,
                'status': 'sharing',
                'has_shared_before': True
            })

            # 位置更新後は必ず全員に最新データをブロードキャスト
            await self._broadcast_locations()

        except ValidationError as e:
            await self._send_error(str(e))

    async def _handle_background_status_update(self, data: Dict[str, Any]):
        """バックグラウンド状態更新（即座対応版）"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            participant_name = self._sanitize_participant_name(data.get('participant_name', ''))
            is_background = bool(data.get('is_background', False))
            is_sharing = bool(data.get('is_sharing', False))
            is_mobile = bool(data.get('is_mobile', False))
            page_unloading = bool(data.get('page_unloading', False))
            maintain_active = bool(data.get('maintain_active', False))
            immediate_transition = bool(data.get('immediate_transition', False))

            self.is_mobile = is_mobile

            # 即座移行の場合は遅延なしで処理
            if immediate_transition:
                logger.info(f"Immediate background transition for {participant_id}: {is_background}")
                
                status = 'sharing' if is_sharing else 'waiting'
                await self._update_participant_status(
                    participant_id, participant_name, 
                    is_online=True,
                    status=status, 
                    is_background=is_background,
                    page_unloading=page_unloading,
                    immediate_update=True
                )
                
                # 即座にブロードキャスト
                await self._broadcast_locations()
                return

            # ページ閉じ時の処理
            if page_unloading:
                logger.info(f"Page unloading detected for {participant_id}")
                
                status = 'sharing' if is_sharing else 'waiting'
                await self._update_participant_status(
                    participant_id, participant_name, 
                    is_online=True,
                    status=status, 
                    is_background=True,
                    page_unloading=True,
                    preserve_name=True  # ページ閉じ時は名前保持
                )
                
            else:
                # 通常のバックグラウンド状態変更
                status = 'sharing' if is_sharing else 'waiting'
                await self._update_participant_status(
                    participant_id, participant_name, 
                    is_online=True, 
                    status=status, 
                    is_background=is_background
                )

            await self._broadcast_locations()

        except ValidationError as e:
            await self._send_error(str(e))

    async def _handle_stop_sharing(self, data: Dict[str, Any]):
        """共有停止処理（位置情報保持版・方向指示削除対応）"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            participant_name = self._sanitize_participant_name(data.get('participant_name', ''))
            remove_direction_indicator = bool(data.get('remove_direction_indicator', False))  # ★ 追加

            # 位置情報は保持したまま、ステータスのみ変更
            await self._update_participant_status(
                participant_id, participant_name, 
                is_online=True, 
                status='waiting',  # 共有停止状態
                clear_location=False,  # 位置情報は保持
                preserve_has_shared=True  # 共有履歴も保持
            )
            
            # ★ 追加：方向指示削除を明示的にブロードキャスト
            if remove_direction_indicator:
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'direction_indicator_removal',
                        'participant_id': participant_id
                    }
                )
            
            await self._broadcast_locations()

        except ValidationError as e:
            await self._send_error(str(e))

    async def direction_indicator_removal(self, event):
        """方向指示削除のブロードキャスト"""
        await self.send_json({
            'type': 'remove_direction_indicator',
            'participant_id': event['participant_id']
        })

    async def _handle_ping(self, data: Dict[str, Any]):
        """Ping処理（滞在時間と速度情報を含む）"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            is_sharing = bool(data.get('is_sharing', False))
            is_background = bool(data.get('is_background', False))
            is_mobile = bool(data.get('is_mobile', False))
            has_position = bool(data.get('has_position', False))
            
            # ★ 追加：速度情報の取得
            current_speed = float(data.get('current_speed', 0)) if data.get('current_speed') is not None else 0
            is_moving = bool(data.get('is_moving', False))

            self.is_mobile = is_mobile

            # ステータス更新（速度情報も含む）
            status = 'sharing' if is_sharing else 'waiting'
            await self._update_participant_last_seen_with_speed(
                participant_id, status, is_background, has_position,
                current_speed, is_moving
            )

            # Ping応答（速度情報を確認）
            await self.send_json({
                'type': 'pong',
                'timestamp': data.get('timestamp'),
                'participant_id': participant_id,
                'server_time': timezone.now().isoformat(),
                'keep_alive': True,
                'speed_acknowledged': True,  # ★ 速度情報受信確認
                'current_speed': current_speed
            })
            
            # ★ 追加：共有中かつ移動中の場合は速度情報もブロードキャスト
            if is_sharing and has_position and is_moving:
                await self._broadcast_locations()  # 位置情報に速度も含まれる

        except ValidationError as e:
            await self._send_error(str(e))

    async def _handle_sync_status(self, data: Dict[str, Any]):
        """状態同期処理"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            participant_name = self._sanitize_participant_name(data.get('participant_name', ''))
            is_sharing = bool(data.get('is_sharing', False))
            status = data.get('status', 'waiting')

            if status not in Config.ALLOWED_STATUSES:
                status = 'waiting'

            final_status = 'sharing' if (is_sharing and status == 'sharing') else 'waiting'
            clear_location = not (is_sharing and status == 'sharing')

            await self._update_participant_status(
                participant_id, participant_name, is_online=True, 
                status=final_status, clear_location=clear_location
            )
            await self._broadcast_locations()

        except ValidationError as e:
            await self._send_error(str(e))

    async def _handle_offline(self, data: Dict[str, Any]):
        """オフライン処理（名前保持対応）"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))

            # 名前を保持してオフライン化
            await self._update_participant_status(
                participant_id, '', 
                is_online=False, 
                status='stopped', 
                clear_location=False,  # 位置情報は保持
                preserve_name=True  # 名前を保持
            )
            await self._broadcast_locations()

        except ValidationError as e:
            await self._send_error(str(e))

    async def _handle_leave(self, data: Dict[str, Any]):
        """退出処理（完全削除版）"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            
            # 退出フラグを設定
            self._is_leaving = True
            
            logger.info(f"User leaving: {participant_id}")
            
            # 参加者を完全削除
            await self._completely_remove_participant(participant_id)
            
            # 削除後にブロードキャスト
            await self._broadcast_locations()
            
            # レスポンスを送信
            await self.send_json({
                'type': 'leave_confirmed',
                'participant_id': participant_id,
                'message': '退出処理完了'
            })
            
            # WebSocket接続を閉じる
            await self.close(code=1000, reason='user_leave')
            
        except ValidationError as e:
            await self._send_error(str(e))

    @database_sync_to_async
    def _completely_remove_participant(self, participant_id: str):
        """参加者を完全に削除（is_activeをFalseにするだけでなく、削除）"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            
            # 該当参加者のデータを完全削除
            deleted_count = LocationData.objects.filter(
                session=session,
                participant_id=participant_id
            ).delete()[0]
            
            logger.info(f"参加者を完全削除: {participant_id} (削除数: {deleted_count})")
            
            # チャットの未読カウントもクリア（オプション）
            ChatUnreadCount.objects.filter(
                session=session,
                participant_id=participant_id
            ).delete()
            
        except Exception as e:
            logger.error(f"Complete participant removal error: {str(e)}")

    async def _handle_name_update(self, data: Dict[str, Any]):
        """名前更新処理（重複オフライン参加者のクリーンアップ付き）"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            participant_name = self._sanitize_participant_name(data.get('participant_name', ''))
            
            # ★ 追加：名前変更前に古いオフライン参加者をクリーンアップ
            await self._cleanup_old_offline_participants(participant_name)
            
            await self._update_participant_status(participant_id, participant_name, is_online=True)
            await self._broadcast_locations()
            
            # 名前更新成功の応答
            await self.send_json({
                'type': 'name_update_response',
                'success': True,
                'participant_name': participant_name,
                'participant_id': participant_id
            })
            
        except ValidationError as e:
            await self._send_error(str(e))


    @database_sync_to_async
    def _cleanup_old_offline_participants(self, new_name: str):
        """古いオフライン参加者をクリーンアップ"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            
            # 同じ名前のオフライン参加者を検索
            old_participants = LocationData.objects.filter(
                session=session,
                participant_name__iexact=new_name,  # 大文字小文字を無視して比較
                is_online=False,
                is_active=True
            ).exclude(participant_id=self.participant_id)
            
            if old_participants.exists():
                count = old_participants.count()
                # 非アクティブ化
                old_participants.update(is_active=False)
                logger.info(f"名前変更により古いオフライン参加者を非アクティブ化: {count}件 (名前: {new_name})")
                
                return count
            
            return 0
            
        except Exception as e:
            logger.error(f"Old participant cleanup error: {str(e)}")
            return 0

    async def _handle_notification(self, data: Dict[str, Any]):
        """通知処理"""
        try:
            participant_id = self._validate_participant_id(data.get('participant_id'))
            participant_name = self._sanitize_participant_name(data.get('participant_name', ''))
            message = self._sanitize_message(data.get('message', ''))
            notification_type = data.get('notification_type', 'info')

            if notification_type not in Config.ALLOWED_NOTIFICATION_TYPES:
                notification_type = 'info'

            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'notification_broadcast',
                    'participant_id': participant_id,
                    'participant_name': participant_name,
                    'message': message,
                    'notification_type': notification_type,
                    'timestamp': timezone.now().isoformat()
                }
            )

        except ValidationError as e:
            await self._send_error(str(e))

    # === 内部処理メソッド ===

    async def _handle_immediate_offline(self):
        """即座オフライン処理"""
        if self.participant_id:
            await self._update_participant_status(
                self.participant_id, '', is_online=False, 
                status='stopped', clear_location=True
            )
            await self._broadcast_locations()

    async def _handle_page_close_disconnect(self):
        """ページ閉じ時の切断処理（12時間遅延）"""
        if self.participant_id:
            # バックグラウンド状態で維持（12時間遅延）
            delay = 43200  # 12時間 = 43200秒
            await self._schedule_delayed_offline(delay, is_page_close=True)

    async def _schedule_delayed_offline(self, delay_seconds: int, is_page_close: bool = False):
        """遅延オフライン処理（未共有参加者は除外）"""
        def delayed_task():
            time.sleep(delay_seconds)
            try:
                from django.db import connection
                connection.close()  # 新しい接続を使用
                
                session = LocationSession.objects.get(session_id=self.session_id)
                participant = LocationData.objects.filter(
                    session=session, participant_id=self.participant_id
                ).first()

                if participant and participant.is_online:
                    # ★ 追加：未共有（waiting）状態の参加者はオフラインにしない
                    if participant.status == 'waiting':
                        logger.info(f"未共有参加者のオフライン処理をスキップ: {self.participant_id}")
                        return
                    
                    time_diff = (timezone.now() - participant.last_updated).total_seconds()
                    margin = 60 if is_page_close else 30  # ページ閉じの場合はより長い余裕
                    
                    if time_diff >= delay_seconds - margin:
                        # 名前を保持してオフライン化
                        preserved_name = participant.participant_name
                        LocationData.objects.filter(
                            session=session, participant_id=self.participant_id
                        ).update(
                            participant_name=preserved_name,  # 名前を明示的に保持
                            is_online=False,
                            status='stopped',
                            last_updated=timezone.now(),
                            last_seen_at=timezone.now()
                        )
                        logger.info(f"遅延オフライン実行（名前保持）: {self.participant_id} -> {preserved_name} (page_close: {is_page_close})")

            except Exception as e:
                logger.error(f"Delayed offline error: {str(e)}")

        thread = threading.Thread(target=delayed_task, daemon=True)
        thread.start()

    # === 検証メソッド ===

    def _validate_session_id(self, session_id: str) -> bool:
        """セッションID検証"""
        if not session_id:
            return False
        try:
            uuid.UUID(session_id)
            return True
        except ValueError:
            return False

    def _validate_participant_id(self, participant_id: str) -> str:
        """参加者ID検証"""
        if not participant_id:
            raise ValidationError('参加者IDが必要です')
        try:
            uuid.UUID(participant_id)
            return participant_id
        except ValueError:
            raise ValidationError('無効な参加者IDです')

    def _validate_coordinates(self, latitude, longitude) -> tuple:
        """座標検証"""
        try:
            lat = float(latitude) if latitude is not None else None
            lng = float(longitude) if longitude is not None else None

            if lat is None or lng is None:
                raise ValidationError('緯度・経度が必要です')

            if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
                raise ValidationError('座標が範囲外です')

            return lat, lng
        except (ValueError, TypeError):
            raise ValidationError('無効な座標形式です')

    def _validate_accuracy(self, accuracy) -> Optional[float]:
        """精度検証"""
        if accuracy is None:
            return None
        try:
            acc = float(accuracy)
            return max(0, min(acc, 10000))  # 0-10km範囲
        except (ValueError, TypeError):
            return None

    def _sanitize_participant_name(self, name: str) -> str:
        """参加者名サニタイズ"""
        if not name:
            return ''
        name = escape(name.strip())
        return name[:Config.MAX_PARTICIPANT_NAME_LENGTH]

    def _sanitize_message(self, message: str) -> str:
        """メッセージサニタイズ"""
        if not message:
            return ''
        message = escape(message.strip())
        return message[:Config.MAX_MESSAGE_LENGTH]

    def _get_client_ip(self) -> str:
        """クライアントIP取得"""
        headers = dict(self.scope.get('headers', []))

        # X-Forwarded-For
        x_forwarded_for = headers.get(b'x-forwarded-for')
        if x_forwarded_for:
            ip = x_forwarded_for.decode().split(',')[0].strip()
            if re.match(r'^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$', ip):
                return ip

        # X-Real-IP
        x_real_ip = headers.get(b'x-real-ip')
        if x_real_ip:
            ip = x_real_ip.decode().strip()
            if re.match(r'^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$', ip):
                return ip

        return self.scope.get('client', ['127.0.0.1', 0])[0]

    async def _check_rate_limit(self) -> bool:
        """レート制限チェック"""
        now = timezone.now()
        if (now - self.last_message_time).total_seconds() >= 60:
            self.message_count = 0
            self.last_message_time = now

        self.message_count += 1
        return self.message_count <= Config.MAX_MESSAGES_PER_MINUTE

    async def _check_connection_limit(self) -> bool:
        """接続数制限チェック"""
        cache_key = f'ws_connections_{self.session_id}'
        connection_count = cache.get(cache_key, 0)

        if connection_count >= Config.MAX_CONNECTIONS_PER_SESSION:
            return False

        cache.set(cache_key, connection_count + 1, 300)
        return True

    # === ユーティリティメソッド ===

    async def _send_error(self, message: str):
        """エラー送信"""
        await self.send_json({'type': 'error', 'message': escape(message)})

    async def send_json(self, data: Dict[str, Any]):
        """JSON送信"""
        try:
            await self.send(text_data=json.dumps(data))
        except Exception as e:
            logger.error(f"JSON send error: {str(e)}")

    async def _broadcast_locations(self):
        """位置情報ブロードキャスト（オフライン参加者も含む）"""
        try:
            locations = await self._get_all_locations()
            await self.channel_layer.group_send(
                self.room_group_name,
                {'type': 'location_broadcast', 'locations': locations}
            )
        except Exception as e:
            logger.error(f"Broadcast error: {str(e)}")

    # === グループメッセージハンドラー ===

    async def location_broadcast(self, event):
        await self.send_json({'type': 'location_update', 'locations': event['locations']})

    async def notification_broadcast(self, event):
        await self.send_json({
            'type': 'notification',
            'participant_id': event['participant_id'],
            'participant_name': event['participant_name'],
            'message': event['message'],
            'notification_type': event['notification_type'],
            'timestamp': event['timestamp']
        })

    # === データベース操作メソッド ===

    @database_sync_to_async
    def _check_session_exists(self) -> bool:
        """セッション存在チェック"""
        try:
            return LocationSession.objects.filter(session_id=self.session_id).exists()
        except Exception:
            return False

    @database_sync_to_async
    def _check_session_valid(self) -> bool:
        """セッション有効性チェック"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            return timezone.now() < session.expires_at
        except LocationSession.DoesNotExist:
            return False

    @database_sync_to_async
    def _get_participant_by_ip(self) -> Optional[Dict[str, Any]]:
        """IP別参加者取得（互換性のために保持、内部では新しい検索を使用）"""
        try:
            # 古い形式での検索（フォールバック用）
            session = LocationSession.objects.get(session_id=self.session_id)
            cutoff_time = timezone.now() - timedelta(days=7)

            participant = LocationData.objects.filter(
                session=session,
                ip_address=self.client_ip,
                first_seen__gte=cutoff_time,
                is_active=True
            ).order_by('-last_updated').first()

            if participant:
                return {
                    'participant_id': participant.participant_id,
                    'participant_name': participant.participant_name,
                    'is_existing': True,
                    'ip_changed': False  # IP検索なので変更なし
                }
            return None
        except Exception as e:
            logger.error(f"IP lookup error: {str(e)}")
            return None

    @database_sync_to_async
    def _update_participant_status(self, participant_id: str, participant_name: str, 
                     is_online: bool = True, status: Optional[str] = None,
                     is_background: bool = False, clear_location: bool = False,
                     page_unloading: bool = False, immediate_update: bool = False,
                     priority_online: bool = False, page_returning: bool = False,
                     update_ip: bool = False, persistent_id: Optional[str] = None,
                     session_fingerprint: Optional[str] = None, 
                     preserve_name: bool = False, preserve_has_shared: bool = False):
        """参加者状態更新（名前・共有履歴保持対応版）"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)

            # 既存の参加者情報を取得
            existing_location = LocationData.objects.filter(
                session=session,
                participant_id=participant_id
            ).first()

            # 名前保持ロジック
            if preserve_name and existing_location and existing_location.participant_name:
                # 既存の名前を保持
                final_participant_name = existing_location.participant_name
                logger.info(f"名前を保持: {participant_id} -> {final_participant_name}")
            elif participant_name and participant_name.strip():
                # 新しい名前が提供された場合
                final_participant_name = participant_name.strip()
            elif existing_location and existing_location.participant_name:
                # 既存の名前がある場合はそれを使用
                final_participant_name = existing_location.participant_name
            else:
                # フォールバック
                final_participant_name = f'参加者{participant_id[:4]}'

            defaults = {
                'participant_name': final_participant_name,  # 保持された名前を使用
                'is_online': is_online,
                'is_active': True,
                'is_background': is_background,
                'is_mobile': self.is_mobile,
                'last_updated': timezone.now(),
                'last_seen_at': timezone.now(),  # 
                'first_seen': timezone.now(),
            }

            # IP更新が必要な場合のみIPアドレスを更新
            if update_ip or not hasattr(self, '_ip_set'):
                defaults['ip_address'] = self.client_ip
                self._ip_set = True

            # 永続IDがある場合は設定
            if persistent_id:
                defaults['persistent_participant_id'] = persistent_id

            # セッションフィンガープリントがある場合は設定
            if session_fingerprint:
                defaults['session_fingerprint'] = session_fingerprint

            if status:
                defaults['status'] = status

            # 共有履歴の保持・更新
            if preserve_has_shared and existing_location:
                # 既存の共有履歴を保持
                defaults['has_shared_before'] = existing_location.has_shared_before
            elif status == 'sharing':
                # 共有開始時は履歴をTrueに
                defaults['has_shared_before'] = True

            if clear_location:
                defaults.update({
                    'latitude': None,
                    'longitude': None,
                    'accuracy': None,
                })
            elif existing_location and not clear_location:
                # 位置情報を保持する場合は既存の値を維持
                defaults.update({
                    'latitude': existing_location.latitude,
                    'longitude': existing_location.longitude,
                    'accuracy': existing_location.accuracy,
                })

            # 優先オンライン復帰の処理
            if priority_online or page_returning:
                defaults.update({
                    'is_online': True,
                    'is_background': False,
                    'last_updated': timezone.now(),
                    'last_seen_at': timezone.now(),
                })
                logger.info(f"優先オンライン復帰処理: {participant_id} (priority: {priority_online}, returning: {page_returning})")

            # 即座更新またはページ閉じ時の処理
            if immediate_update or page_unloading:
                if not priority_online:
                    defaults['is_background'] = True
                if page_unloading and not priority_online:
                    defaults['is_online'] = True
                
                # ページ閉じ時の名前保持ログ
                if page_unloading and preserve_name:
                    logger.info(f"ページ閉じ時の名前保持: {participant_id} -> {final_participant_name}")
                
                logger.info(f"即座状態更新: {participant_id} (immediate: {immediate_update}, page_unloading: {page_unloading}, priority: {priority_online})")

            location, created = LocationData.objects.update_or_create(
                session=session,
                participant_id=participant_id,
                defaults=defaults
            )

            if not created:
                # 既存レコードの名前を確実に保持
                if preserve_name or not participant_name:
                    # 名前保持フラグがある場合、または新しい名前が提供されていない場合
                    location.participant_name = final_participant_name
                elif participant_name and participant_name.strip():
                    # 新しい名前が提供された場合
                    location.participant_name = participant_name.strip()
                
                # IP更新フラグがある場合は更新
                if update_ip:
                    location.ip_address = self.client_ip
                    logger.info(f"IP address updated for {participant_id}: {self.client_ip}")
                
                # 永続IDを設定
                if persistent_id and hasattr(location, 'persistent_participant_id'):
                    location.persistent_participant_id = persistent_id
                    
                # セッションフィンガープリントを設定
                if session_fingerprint and hasattr(location, 'session_fingerprint'):
                    location.session_fingerprint = session_fingerprint

                # last_seen_at の更新
                location.last_seen_at = timezone.now()
                
                location.save()

            # 名前保持の確認ログ
            if preserve_name:
                logger.info(f"名前保持完了: {participant_id} -> {location.participant_name}")

            # 優先オンライン復帰の場合はログ出力
            if priority_online:
                logger.info(f"優先オンライン復帰完了: {participant_id} - online: {location.is_online}, background: {location.is_background}")

        except Exception as e:
            logger.error(f"Participant status update error: {str(e)}")

    @database_sync_to_async
    def _update_participant_last_seen_with_speed(self, participant_id: str, status: str, 
                                                is_background: bool, has_position: bool = False,
                                                current_speed: float = 0, is_moving: bool = False):
        """最終確認時刻更新（滞在時間と速度情報も含む）"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            location = LocationData.objects.filter(
                session=session,
                participant_id=participant_id
            ).first()
            
            if location:
                # 滞在時間を再計算
                if location.stay_start_time and status == 'sharing':
                    elapsed = (timezone.now() - location.stay_start_time).total_seconds() / 60
                    location.total_stay_minutes = int(elapsed)
                    logger.debug(f"Ping時の滞在時間更新: {participant_id} - {location.total_stay_minutes}分")
                
                # ★ 追加：速度情報を保存（フィールドが存在する場合）
                if hasattr(location, 'current_speed'):
                    location.current_speed = current_speed
                if hasattr(location, 'is_moving'):
                    location.is_moving = is_moving
                
                logger.info(f"速度情報更新: {participant_id} - {current_speed:.1f}km/h (moving: {is_moving})")
                
                # 更新
                location.last_seen_at = timezone.now()
                location.is_online = True
                location.is_background = is_background
                location.status = status
                
                if has_position:
                    location.last_updated = timezone.now()
                
                location.save()

        except Exception as e:
            logger.error(f"Last seen with speed update error: {str(e)}")

    @database_sync_to_async
    def _save_location_data(self, data: Dict[str, Any]):
        """位置情報保存（サーバー側滞在時間管理版）"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            
            # 既存の位置データを取得
            existing_location = LocationData.objects.filter(
                session=session,
                participant_id=data['participant_id']
            ).first()
            
            stay_start_time = None
            total_stay_minutes = 0
            
            if existing_location:
                # 位置が変わったかチェック（30m閾値）★ 変更
                if (existing_location.latitude and existing_location.longitude and
                    data.get('latitude') and data.get('longitude')):
                    
                    # 距離を計算
                    from math import radians, cos, sin, asin, sqrt
                    def haversine(lon1, lat1, lon2, lat2):
                        lon1, lat1, lon2, lat2 = map(radians, [lon1, lat1, lon2, lat2])
                        dlon = lon2 - lon1 
                        dlat = lat2 - lat1 
                        a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
                        c = 2 * asin(sqrt(a)) 
                        r = 6371000  # メートル単位
                        return c * r
                    
                    distance = haversine(
                        float(existing_location.longitude), 
                        float(existing_location.latitude),
                        float(data['longitude']), 
                        float(data['latitude'])
                    )
                    
                    if distance >= 30:  # ★ 30m以上移動（20mから変更）
                        logger.info(f"滞在地点変更検出: {distance:.1f}m移動 - 滞在時間リセット")
                        stay_start_time = timezone.now()
                        total_stay_minutes = 0  # リセット
                    else:
                        # 同じ場所に滞在中 - サーバー側で時間を計算
                        if existing_location.stay_start_time:
                            stay_start_time = existing_location.stay_start_time
                            # 現在までの経過時間を計算
                            elapsed = (timezone.now() - stay_start_time).total_seconds() / 60
                            total_stay_minutes = int(elapsed)
                            logger.info(f"{data['participant_id']}: 滞在継続 {total_stay_minutes}分")
                        else:
                            stay_start_time = timezone.now()
                            total_stay_minutes = 0
                else:
                    # 初回または位置情報なし
                    stay_start_time = timezone.now()
                    total_stay_minutes = 0
            else:
                # 新規参加者
                stay_start_time = timezone.now()
                total_stay_minutes = 0

            location, created = LocationData.objects.update_or_create(
                session=session,
                participant_id=data['participant_id'],
                defaults={
                    'participant_name': data['participant_name'],
                    'latitude': data['latitude'],
                    'longitude': data['longitude'],
                    'accuracy': data.get('accuracy'),
                    'last_updated': timezone.now(),
                    'last_seen_at': timezone.now(),
                    'is_active': True,
                    'is_online': data.get('is_online', True),
                    'is_background': data.get('is_background', False),
                    'is_mobile': self.is_mobile,
                    'status': data.get('status', 'sharing'),
                    'ip_address': self.client_ip,
                    'has_shared_before': data.get('has_shared_before', True),
                    'stay_start_time': stay_start_time,
                    'total_stay_minutes': total_stay_minutes,
                }
            )

            if created:
                location.first_seen = timezone.now()
                location.save()

            return location
        except Exception as e:
            logger.error(f"Location save error: {str(e)}")
            return None

    @database_sync_to_async
    def _get_all_locations(self) -> List[Dict[str, Any]]:
        """全位置情報取得（速度情報含む）"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            
            locations = LocationData.objects.filter(
                session=session,
                is_active=True
            ).order_by('-last_updated')

            result = []
            for loc in locations:
                has_location = (loc.latitude is not None and 
                            loc.longitude is not None and 
                            loc.latitude != 999.0 and 
                            loc.longitude != 999.0)
                
                should_display = (
                    getattr(loc, 'has_shared_before', False) or
                    loc.is_online or
                    loc.status == 'waiting'
                )
                
                if should_display:
                    # サーバー側で滞在時間を計算
                    stay_minutes = 0
                    
                    if loc.stay_start_time and loc.is_online and loc.status == 'sharing':
                        elapsed = (timezone.now() - loc.stay_start_time).total_seconds() / 60
                        stay_minutes = int(elapsed)
                    elif loc.total_stay_minutes:
                        stay_minutes = loc.total_stay_minutes
                    
                    location_data = {
                        'participant_id': loc.participant_id,
                        'participant_name': escape(loc.participant_name or f'参加者{loc.participant_id[:4]}'),
                        'latitude': float(loc.latitude) if has_location else None,
                        'longitude': float(loc.longitude) if has_location else None,
                        'accuracy': float(loc.accuracy) if (has_location and loc.accuracy) else None,
                        'last_updated': loc.last_updated.isoformat(),
                        'last_seen_at': loc.last_seen_at.isoformat() if getattr(loc, 'last_seen_at', None) else None,
                        'is_background': loc.is_background,
                        'is_online': loc.is_online,
                        'is_mobile': getattr(loc, 'is_mobile', False),
                        'status': loc.status,
                        'has_shared_before': getattr(loc, 'has_shared_before', False),
                        'stay_minutes': stay_minutes,
                        # ★ 追加：速度情報
                        'current_speed': getattr(loc, 'current_speed', 0),
                        'is_moving': getattr(loc, 'is_moving', False),
                    }
                    result.append(location_data)

            return result

        except Exception as e:
            logger.error(f"Location fetch error: {str(e)}")
            return []


    def _calculate_current_stay_time(self, location_data) -> int:
        """現在の滞在時間を計算（改善版）"""
        try:
            if not location_data.stay_start_time:
                return 0
            
            # オンラインかつ共有中の場合のみ滞在時間を計算
            if location_data.is_online and location_data.status == 'sharing':
                now = timezone.now()
                current_stay = (now - location_data.stay_start_time).total_seconds() / 60
                total_minutes = location_data.total_stay_minutes or 0
                return int(total_minutes + current_stay)
            else:
                # オフラインまたは未共有の場合は保存された値を返す
                return location_data.total_stay_minutes or 0
        except Exception as e:
            logger.error(f"Stay time calculation error: {str(e)}")
            return 0


    def _calculate_stay_time(self, location_data) -> int:
        """滞在時間計算"""
        try:
            if hasattr(location_data, 'stay_start_time') and location_data.stay_start_time:
                now = timezone.now()
                stay_duration = (now - location_data.stay_start_time).total_seconds() / 60
                return int(stay_duration) + getattr(location_data, 'total_stay_minutes', 0)
            return getattr(location_data, 'total_stay_minutes', 0)
        except Exception:
            return 0

    @database_sync_to_async
    def _deactivate_participant(self, participant_id: str):
        """参加者非アクティブ化"""
        try:
            session = LocationSession.objects.get(session_id=self.session_id)
            LocationData.objects.filter(
                session=session,
                participant_id=participant_id
            ).update(
                is_active=False,
                is_online=False,
                status='stopped',
                latitude=None,
                longitude=None,
                accuracy=None,
                last_updated=timezone.now(),
                last_seen_at=timezone.now()  # 
            )
        except Exception as e:
            logger.error(f"Participant deactivation error: {str(e)}")


# === Celeryタスク（別ファイルまたは同じファイル内） ===
from celery import shared_task

@shared_task
def cleanup_offline_participants():
    """長期間オフラインの参加者データをクリーンアップ（未共有参加者は除外）"""
    try:
        # 7日間以上オフラインの参加者を削除
        cutoff_time = timezone.now() - timedelta(days=7)
        
        # ★ 修正：waiting状態の参加者は削除対象から除外
        expired_participants = LocationData.objects.filter(
            is_online=False,
            last_seen_at__lt=cutoff_time
        ).exclude(
            status='waiting'  # ★ 追加：未共有参加者は削除しない
        )
        
        count = expired_participants.count()
        expired_participants.delete()
        
        logger.info(f"オフライン参加者クリーンアップ完了: {count}件削除（未共有参加者は除外）")
        return f"削除件数: {count}"
        
    except Exception as e:
        logger.error(f"オフライン参加者クリーンアップエラー: {str(e)}")
        return f"エラー: {str(e)}"

@shared_task
def cleanup_expired_sessions():
    """期限切れセッションとその参加者を削除"""
    try:
        # 期限切れセッションを削除（CASCADE で参加者も自動削除）
        expired_sessions = LocationSession.objects.filter(
            expires_at__lt=timezone.now()
        )
        
        count = expired_sessions.count()
        expired_sessions.delete()
        
        logger.info(f"期限切れセッション削除完了: {count}件削除")
        return f"削除件数: {count}"
        
    except Exception as e:
        logger.error(f"期限切れセッション削除エラー: {str(e)}")
        return f"エラー: {str(e)}"