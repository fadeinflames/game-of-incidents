-- The feature set of the bot-scoring model: one row per feature column of request_features.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'request_features'
  AND column_name <> 'ts'
ORDER BY column_name;
