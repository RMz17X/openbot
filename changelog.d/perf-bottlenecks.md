### Changed

- Optimize SQLite transactions by switching WAL journal synchronization to NORMAL in WhatsApp auth-store and AgentDatabaseHost.
- Optimize telemetry event queue pruning to prevent repeated serialization overhead.
