# X Solution API — Official WhatsApp Cloud API Server

Ban-safe, official server for **bulk sending with media** (images, videos,
documents, audio) via Meta's WhatsApp Business Cloud API. No QR needed —
the number is connected once in the Meta dashboard.

## 1. Meta setup (one time, ~30 min)

1. Go to **developers.facebook.com** → create an App → add the **WhatsApp** product.
2. In **API Setup** you get a free **test number** + temporary token (24h) — good for testing.
3. For production:
   - **Business Settings** → create a **System User** with the
     `whatsapp_business_messaging` permission → generate a **permanent token**.
     Save it as `WHATSAPP_TOKEN`.
   - Add your real WhatsApp number under **WhatsApp → API Setup** → copy the
     **Phone number ID** → save as `PHONE_NUMBER_ID`.
   - Complete **Business Verification** to raise messaging limits
     (1,000 → 10,000 → 100,000 → unlimited / 24h).
   - Create **Message Templates** (marketing/utility) and get them approved —
     bulk messages outside the 24-hour customer window MUST use templates.

## 2. Deploy on Render

Option A — Blueprint (this repo has `render.yaml`):
1. Push this folder to GitHub.
2. Render → **New → Blueprint** → select the repo → Apply.
3. Fill in env vars: `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`
   (`API_KEY` and `WEBHOOK_VERIFY_TOKEN` are auto-generated).

Option B — manual: Render → New → Web Service → `npm install` / `node server.js`,
add the same env vars.

## 3. Connect the webhook

In Meta dashboard → **WhatsApp → Configuration**:
- Callback URL: `https://YOUR-SERVICE.onrender.com/webhook`
- Verify token: the `WEBHOOK_VERIFY_TOKEN` value from Render
- Subscribe to the **messages** field.

## 4. Test

```bash
# health
curl https://YOUR-SERVICE.onrender.com/api/health

# send text
curl -X POST https://YOUR-SERVICE.onrender.com/api/send-text \
  -H "x-api-key: YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"923001234567","message":"Hello from X Solution API"}'

# send image
curl -X POST https://YOUR-SERVICE.onrender.com/api/send-media \
  -H "x-api-key: YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"923001234567","media_type":"image","url":"https://example.com/offer.jpg","caption":"Eid Offer 🎉"}'

# bulk: 500 numbers, one image each (queued ~1/sec, returns job id)
curl -X POST https://YOUR-SERVICE.onrender.com/api/broadcast \
  -H "x-api-key: YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"recipients":["92300...","92301..."],"kind":"media","media_type":"image","url":"https://example.com/offer.jpg","caption":"Offer 🎉"}'

# check progress
curl "https://YOUR-SERVICE.onrender.com/api/broadcast/job_1_abc?key=YOUR_API_KEY"
```

## Notes

- **Bulk marketing** = use `kind: "template"` with an approved template name.
- Broadcast jobs run **in-memory**; for big production volumes use Redis/DB.
- Pace is ~1 msg/sec — raise carefully, Meta rate-limits aggressively.
- Never commit real tokens to git — use Render env vars.
