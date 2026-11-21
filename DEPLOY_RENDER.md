# Deploying the Kuwana API to Render (MVP / demo)

This sets up the API, Postgres and Redis on Render from [render.yaml](render.yaml), with uploads on Cloudflare R2.
It takes about 20 minutes and costs about $25/month.

The deployment runs in **demo mode**: payments succeed instantly (mock gateway) and SMS verification codes are
written to the Render log instead of being sent. Don't take real orders until you switch that off (see the end).

## 1. Create the R2 bucket for uploads (5 minutes, free tier)

1. In the Cloudflare dashboard, open **R2 Object Storage** and create a bucket named `kuwana-uploads`.
2. In the bucket's **Settings → Public access**, enable the **r2.dev subdomain**. Copy the public URL
   (`https://pub-….r2.dev`).
3. In **R2 → Manage R2 API Tokens**, create a token with **Object Read & Write** on that bucket. Copy the
   **Access Key ID**, the **Secret Access Key**, and the **S3 endpoint** host
   (`<account-id>.r2.cloudflarestorage.com`, without `https://`).

## 2. Create the services from the blueprint

1. Sign in to [render.com](https://render.com) with the GitHub account that can see `RobertMudzonga/Kuwana_BE`.
2. **New → Blueprint**, pick the `Kuwana_BE` repository and the `feature/ordering-platform` branch.
3. Render reads `render.yaml` and asks for the values marked `sync: false`:

   | Variable | Value |
   |---|---|
   | `MINIO_ENDPOINT` | `<account-id>.r2.cloudflarestorage.com` |
   | `MINIO_ACCESS_KEY` | R2 Access Key ID |
   | `MINIO_SECRET_KEY` | R2 Secret Access Key |
   | `MINIO_PUBLIC_URL` | `https://pub-….r2.dev` |

4. **Apply**. Render creates `kuwana-db`, `kuwana-redis` and `kuwana-api`. The first deploy builds the Docker
   image and runs the database migrations on start. When it's live, the log shows
   `✅ Background jobs on BullMQ` and `🚀 Kuwana API running`.
5. Check it: `https://<your-service>.onrender.com/api/v1/health` should return `"success": true` with `"environment": "production"`.
   The service is usually `kuwana-api.onrender.com`; Render adds a suffix if that name is taken.

## 3. Load the demo data

Seeding runs from your own computer against the Render database, once.

1. In Render, open **kuwana-db → Connect** and copy the **External Database URL**.
2. From the `Kuwana_BE` folder:

   ```bash
   DATABASE_URL="<external url>?sslmode=require" \
   ADMIN_PASSWORD="<a new admin password>" \
   npm run db:seed
   ```

   The seed only adds what's missing, so it's safe to run again. It creates the admin (with the password you
   give), the demo buyers, stores, drivers, the Harare zones and the catalog.

Because the API is on a public URL, use a new `ADMIN_PASSWORD` here rather than the development default.

## 4. Build the app against Render

In `Sosa_Connect/eas.json`, the `demo` profile points at `https://kuwana-api.onrender.com/api/v1`. If Render
gave the service a different URL, change it there first. Then:

```bash
cd Sosa_Connect
eas build --platform android --profile demo
```

That APK works on any phone with internet; your Mac doesn't need to be running.

## Day to day

- **Deploys:** every push to `feature/ordering-platform` redeploys automatically (migrations run on start).
- **SMS codes in demo mode:** open **kuwana-api → Logs** and search for the phone number.
- **Logs and restarts:** in the `kuwana-api` dashboard.
- **Backups:** Render keeps daily backups of paid Postgres plans; you can also download one from the database page.

## Before taking real orders

Set these in **kuwana-api → Environment**, then redeploy:

| Variable | Value |
|---|---|
| `DEMO_MODE` | `false` |
| `ACTIVE_PAYMENT_GATEWAY` | `paynow` (plus `PAYNOW_INTEGRATION_ID`, `PAYNOW_INTEGRATION_KEY`, and the ZiG pair) |
| `SMS_PROVIDER` | `africastalking` or `twilio` (plus its keys) |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | for password-reset emails |

The API refuses to start with mock payments or console SMS once `DEMO_MODE` is `false`, so a missed setting
shows up straight away. At that point it's also worth moving to a Johannesburg host for lower latency in Zimbabwe.
