# tracker/urls.py
from django.urls import path
from . import views

app_name = 'tracker'

urlpatterns = [
    # メインページ
    path('', views.home, name='home'),
    path('contact/', views.contact, name='contact'),
    
    # セッション管理
    path('create/', views.create_session, name='create_session'),
    path('session/<uuid:session_id>/', views.session_created, name='session_created'),
    path('share/<uuid:session_id>/', views.share_location, name='share_location'),
    path('privacy/', views.privacy, name='privacy'),  # プライバシーポリシーページを追加
    
    # API エンドポイント
    path('api/stats/', views.api_get_stats, name='api_get_stats'),
    path('api/session/<uuid:session_id>/update/', views.api_update_location, name='api_update_location'),
    path('api/session/<uuid:session_id>/locations/', views.api_get_locations, name='api_get_locations'),
    path('api/session/<uuid:session_id>/leave/', views.api_leave_session, name='api_leave_session'),
    path('api/session/<uuid:session_id>/offline/', views.api_offline_status, name='api_offline_status'),
    path('api/session/<uuid:session_id>/update-name/', views.api_update_name, name='api_update_name'),
    path('api/session/<uuid:session_id>/status/', views.api_session_status, name='api_session_status'),
    path('api/session/<uuid:session_id>/ping/', views.api_ping, name='api_ping'),
    path('api/session/<uuid:session_id>/stop-sharing/', views.api_stop_sharing, name='api_stop_sharing'),
]