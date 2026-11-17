CREATE INDEX haip_sessions_principal ON haip_sessions ((data->>'tenant'), (data->>'id'))
  WHERE data ? 'tenant' AND data ? 'id';

DELETE FROM haip_sessions AS session USING haip_principals AS principal
  WHERE principal.kind='human' AND principal.config->'enabled' IS DISTINCT FROM 'true'::jsonb
    AND session.data ? 'tenant' AND session.data ? 'id'
    AND session.data->>'tenant'=principal.tenant AND session.data->>'id'=principal.id;
