# location_share/urls.py (推奨版 - 重複を避ける)
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from django.contrib.sitemaps.views import sitemap
from tracker.sitemaps import sitemaps
from django.views.generic import TemplateView

urlpatterns = [
    path('admin/', admin.site.urls),
    
    # trackerアプリのすべてのURLパターンを含める（APIエンドポイントも含む）
    path('', include('tracker.urls')),
    
    # サイトマップのURL
    path('sitemap.xml', sitemap, {'sitemaps': sitemaps}, name='django.contrib.sitemaps.views.sitemap'),
    
    # ロボット.txtのURL（オプション）
    path('robots.txt', TemplateView.as_view(template_name='robots.txt', content_type='text/plain')),
]

# 静的ファイルの配信設定（開発環境のみ）
if settings.DEBUG:
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)