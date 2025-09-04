# tracker/tasks.py
import logging
from celery import shared_task
from django.utils import timezone
from datetime import timedelta
from .models import LocationSession, LocationData, SessionLog

logger = logging.getLogger(__name__)

@shared_task(bind=True)
def cleanup_expired_locations(self):
    """期限切れセッションの位置情報のみを削除"""
    try:
        current_time = timezone.now()
        logger.info(f"クリーンアップ開始時刻: {current_time}")
        
        # 削除対象の位置情報を確認
        expired_locations_query = LocationData.objects.filter(
            session__expires_at__lt=current_time
        )
        expired_locations_count = expired_locations_query.count()
        logger.info(f"削除対象の位置情報数: {expired_locations_count}")
        
        if expired_locations_count == 0:
            logger.info("削除対象の期限切れ位置情報はありません")
            return {
                'success': True,
                'deleted_locations': 0
            }
        
        # デバッグ: 削除対象の詳細をログ出力
        sample_locations = expired_locations_query[:5]
        for loc in sample_locations:
            logger.info(f"削除対象位置情報 ID: {loc.id}, 緯度: {loc.latitude}, 経度: {loc.longitude}, セッション期限: {loc.session.expires_at}")
        
        # 期限切れセッションの位置情報を直接削除
        deleted_locations = expired_locations_query.delete()[0]
        
        logger.info(f"期限切れ位置情報削除完了: {deleted_locations}件")
        
        return {
            'success': True,
            'deleted_locations': deleted_locations
        }
        
    except Exception as e:
        logger.error(f"期限切れ位置情報削除でエラー: {str(e)}")
        # Celeryのリトライ機能を使用
        raise self.retry(exc=e, countdown=300, max_retries=3)

@shared_task
def cleanup_old_logs():
    """古いログエントリを削除（30日以上前）"""
    try:
        cutoff_date = timezone.now() - timedelta(days=30)
        
        deleted_count = SessionLog.objects.filter(
            timestamp__lt=cutoff_date
        ).delete()[0]
        
        if deleted_count > 0:
            logger.info(f"古いログエントリを削除: {deleted_count}件")
        
        return {
            'success': True,
            'deleted_logs': deleted_count
        }
        
    except Exception as e:
        logger.error(f"古いログ削除でエラー: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }

@shared_task
def debug_location_data():
    """位置情報データの状況を詳細に確認"""
    try:
        current_time = timezone.now()
        
        # 全体の統計
        total_sessions = LocationSession.objects.count()
        total_locations = LocationData.objects.count()
        expired_sessions = LocationSession.objects.filter(expires_at__lt=current_time).count()
        expired_locations = LocationData.objects.filter(session__expires_at__lt=current_time).count()
        
        logger.info(f"=== 位置情報データ状況 ===")
        logger.info(f"現在時刻: {current_time}")
        logger.info(f"総セッション数: {total_sessions}")
        logger.info(f"総位置情報数: {total_locations}")
        logger.info(f"期限切れセッション数: {expired_sessions}")
        logger.info(f"期限切れ位置情報数: {expired_locations}")
        
        # サンプルデータの確認
        if expired_locations > 0:
            sample_expired = LocationData.objects.filter(session__expires_at__lt=current_time)[:5]
            for loc in sample_expired:
                logger.info(f"期限切れ位置情報 - ID: {loc.id}, 緯度: {loc.latitude}, 経度: {loc.longitude}, セッション期限: {loc.session.expires_at}")
        
        # 最新のセッション情報も確認
        recent_sessions = LocationSession.objects.order_by('-expires_at')[:3]
        for session in recent_sessions:
            location_count = session.locationdata_set.count()
            logger.info(f"最新セッション - ID: {session.id}, 期限: {session.expires_at}, 位置情報数: {location_count}")
        
        return {
            'current_time': current_time.isoformat(),
            'total_sessions': total_sessions,
            'total_locations': total_locations,
            'expired_sessions': expired_sessions,
            'expired_locations': expired_locations
        }
        
    except Exception as e:
        logger.error(f"デバッグ確認でエラー: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }