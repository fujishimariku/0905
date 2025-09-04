# tracker/sitemaps.py
from django.contrib.sitemaps import Sitemap
from django.urls import reverse
from django.utils import timezone
from datetime import timedelta


class StaticViewSitemap(Sitemap):
    """静的ページのサイトマップ"""
    # クラス変数として設定（メソッドではない）
    priority = 0.8
    changefreq = 'weekly'
    protocol = 'http'  # 開発環境用、本番ではhttpsに変更
    
    def items(self):
        """サイトマップに含める静的ページのURL名のリスト"""
        return [
            'tracker:home',      # ホームページ
            'tracker:contact',   # お問い合わせページ
        ]
    
    def location(self, item):
        """各アイテムのURLを返す"""
        try:
            return reverse(item)
        except Exception as e:
            # URL名が見つからない場合はスキップ
            print(f"URL reverse error for {item}: {e}")
            return None
    
    def lastmod(self, item):
        """最終更新日を返す"""
        return timezone.now() - timedelta(days=7)
    
    def get_priority(self, item):
        """各ページの優先度を設定"""
        priorities = {
            'tracker:home': 1.0,      # ホームページは最高優先度
            'tracker:contact': 0.6,   # お問い合わせページは中程度
        }
        return priorities.get(item, 0.5)
    
    def get_changefreq(self, item):
        """各ページの更新頻度を設定"""
        frequencies = {
            'tracker:home': 'weekly',
            'tracker:contact': 'monthly',
        }
        return frequencies.get(item, 'monthly')


# メインのサイトマップ辞書
sitemaps = {
    'static': StaticViewSitemap,
}