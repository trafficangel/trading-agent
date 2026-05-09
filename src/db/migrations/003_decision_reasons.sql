-- Per-level justifications from the LLM. The model must explain WHY each
-- price level was chosen, and the invalidation condition that kills the idea
-- before SL is hit. Stored for both audit and to render in Telegram captions.
ALTER TABLE decisions ADD COLUMN sl_reason TEXT;
ALTER TABLE decisions ADD COLUMN tp_reason TEXT;
ALTER TABLE decisions ADD COLUMN invalidation TEXT;
