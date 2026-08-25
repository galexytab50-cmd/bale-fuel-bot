-- جدول نگه‌داری وضعیت مکالمه هر کاربر
-- هر ردیف نشون‌دهنده مرحله فعلی مکالمه یک کاربر (chat_id) هست.

CREATE TABLE IF NOT EXISTS conversation_state (
    chat_id         INTEGER PRIMARY KEY,
    step            TEXT NOT NULL,
    car             TEXT,
    daily_km        INTEGER,
    days_per_week   INTEGER,
    driving_style   TEXT,
    updated_at      INTEGER NOT NULL
);
