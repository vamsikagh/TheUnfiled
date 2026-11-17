# Deploy Text Detective to Render

1. Put this deployment source in a GitHub or GitLab repository. A private repository works. Keep local case data and .env files out of the repository.
2. Sign in to Render, select **New → Blueprint**, and connect the repository. Render reads render.yaml and creates a Docker web service.
3. Enter your Gemini API key when Render prompts for GEMINI_API_KEY. Add it as a Render environment secret.
4. Open the service’s onrender.com URL when Render marks it Live. Open that URL in a private browsing window to verify that each browser starts with its own case directory.

The free deployment is a demo. Its SQLite database is stored on the free service's temporary filesystem, so cases can disappear after a restart, spin-down, or redeploy. Visitors should use fictional or redacted evidence. The session is a secure browser cookie, so moving to another browser or clearing the cookie creates a separate workspace. There is a shared request allowance to limit AI usage.

For an always-on deployment with persistent cases, choose an eligible paid service, attach a persistent disk, and set TD_DATA_DIR to a path on that disk writable by the container's node user. The starter deployment never reads the SQLite database on your computer.

For a custom domain, set TD_PUBLIC_ORIGIN to its exact HTTPS origin. Standard Render domains use RENDER_EXTERNAL_URL automatically.
