import os
import django

# Djangoの設定を最初に設定
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'location_share.settings')
django.setup()

# Django設定後にインポート
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
from tracker.routing import websocket_urlpatterns

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AuthMiddlewareStack(
        URLRouter(
            websocket_urlpatterns
        )
    ),
})