# Neon roles

Create a dedicated HAIP database in the selected Neon project. Use the direct connection and schema owner for controlled migrations. Create fresh `haip_runtime` and `haip_backup` login roles without administrative privileges or membership in any other role. Use SQL for creation so you can inspect and control the grants. The project owner manages role credentials separately from HAIP's own operator credentials.

Review and apply [`roles.sql`](roles.sql) after migration as the schema owner, using a direct connection. It removes `PUBLIC` schema creation, restricts runtime table and sequence operations and grants the backup reader access to the listed objects. Apply only in the isolated HAIP database. The script checks its role assumptions and does not create users, passwords or a database. Review effective rights, including inherited and previously assigned grants, separately.

Use the pooled runtime URL with the limited role and `sslmode=verify-full`. The runtime can update the managed commit stamp after provisioning. It does not create the stamp, run migrations or write recovery records. Keep the direct schema owner, backup and recovery connections out of the Vercel runtime. Give the backup job only the separate reader connection, backup encryption key and private backup storage access.

Exercise real transactions and signed review with the runtime role. Prove that schema creation, migration table changes, stamp insertion, tenant mutation beyond its allowed columns and backup writes are refused. Repeat the check after each new migration. An encrypted restore into an empty database does not restore grants because the dump excludes ACLs. Reapply reviewed grants before bringing up the recovered service.
