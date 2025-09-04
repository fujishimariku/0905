from django.urls import path
from . import consumers

websocket_urlpatterns = [
    path('ws/location/<str:session_id>/', consumers.LocationConsumer.as_asgi()),
]