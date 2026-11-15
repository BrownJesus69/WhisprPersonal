"""Future integration inventory. Flags alone never activate an unconfigured service."""

from app.config import Settings
from app.integrations.app_check import DisabledAppCheck
from app.integrations.base import IntegrationStatus
from app.integrations.calendar import DisabledCalendar
from app.integrations.cloud_whisper import DisabledCloudWhisper
from app.integrations.drive import DisabledDrive
from app.integrations.fcm import DisabledFCM
from app.integrations.gmail import DisabledGmail
from app.integrations.web_search import DisabledWebSearch


def integration_status(settings: Settings) -> dict[str, IntegrationStatus]:
    return {
        "calendar": DisabledCalendar(settings.feature_calendar).status(),
        "drive": DisabledDrive(settings.feature_drive).status(),
        "gmail": DisabledGmail(settings.feature_gmail).status(),
        "fcm": DisabledFCM(settings.feature_fcm).status(),
        "web_search": DisabledWebSearch(settings.feature_web_search).status(),
        "cloud_whisper": DisabledCloudWhisper(settings.feature_cloud_whisper).status(),
        "app_check": DisabledAppCheck(settings.feature_app_check).status(),
    }
