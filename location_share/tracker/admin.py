# tracker/admin.py
from django.contrib import admin
from .models import LocationSession, LocationData, SessionLog, WebSocketConnection, ChatMessage, ChatUnreadCount

@admin.register(LocationSession)
class LocationSessionAdmin(admin.ModelAdmin):
    list_display = ['session_id', 'duration_minutes', 'created_at', 'expires_at', 'is_expired_display', 'participant_count']
    list_filter = ['duration_minutes', 'created_at']
    search_fields = ['session_id']
    readonly_fields = ['session_id', 'created_at', 'expires_at']
    
    def participant_count(self, obj):
        return obj.locations.count()
    participant_count.short_description = '参加者数'
    
    def is_expired_display(self, obj):
        return not obj.is_expired()
    is_expired_display.short_description = 'アクティブ'
    is_expired_display.boolean = True

@admin.register(LocationData)
class LocationDataAdmin(admin.ModelAdmin):
    list_display = ['participant_name', 'participant_id', 'session', 'latitude', 'longitude', 'accuracy', 'last_updated']
    list_filter = ['session', 'timestamp']
    search_fields = ['participant_id', 'participant_name']
    readonly_fields = ['timestamp', 'last_updated']

@admin.register(SessionLog)
class SessionLogAdmin(admin.ModelAdmin):
    list_display = ['session', 'action', 'participant_id', 'ip_address', 'timestamp']
    list_filter = ['action', 'timestamp']
    search_fields = ['session__session_id', 'participant_id', 'ip_address']
    readonly_fields = ['timestamp']
