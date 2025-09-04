# location_share/celery.py
import os
from celery import Celery

# Django設定モジュールを指定
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'location_share.settings')

app = Celery('location_share')

# Django設定からCelery設定を読み込み
app.config_from_object('django.conf:settings', namespace='CELERY')

# Djangoアプリからタスクを自動検出
app.autodiscover_tasks()

@app.task(bind=True)
def debug_task(self):
    print(f'Request: {self.request!r}')