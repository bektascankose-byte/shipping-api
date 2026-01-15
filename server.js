import express from "express";
import cors from "cors";
import Stripe from "stripe";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* ======================
   CONFIG
====================== */
const SHIPPO_TOKEN = process.env.SHIPPO_API_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const BASE_URL = process.env.BASE_URL;

const stripe = new Stripe(STRIPE_SECRET);
const SHIPPO_BASE = "https://api.goshippo.com";

/* ======================
   SHIPPO HELPER
====================== */
async function shippoFetch(path, options = {}) {
  const res = await fetch(`${SHIPPO_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `ShippoToken ${SHIPPO_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

/* ======================
   HEALTH CHECK
====================== */
app.get("/", (_, res) => {
  res.json({ status: "ok" });
});

/* ======================================================
   1️⃣ ZAPIER STEP: CREATE SHIPPING SESSION
====================================================== */
app.post("/zapier/create-shipping-session", async (req, res) => {
  try {
    const { from, to, parcel } = req.body;

    const shipment = await shippoFetch("/shipments/", {
      method: "POST",
      body: JSON.stringify({
        address_from: from,
        address_to: to,
        parcels: [parcel],
        async: false
      })
    });

    const sessionId = shipment.object_id;

    res.json({
      shipping_session_id: sessionId,
      checkout_url: `${BASE_URL}/pay-shipping.html?session=${sessionId}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   2️⃣ FRONTEND: FETCH LIVE RATES
====================================================== */
app.get("/api/shipping/:sessionId", async (req, res) => {
  try {
    const shipment = await shippoFetch(`/shipments/${req.params.sessionId}`);

    const rates = shipment.rates.map(r => ({
      rate_id: r.object_id,
      carrier: r.provider,
      service: r.servicelevel.name,
      amount: Number(r.amount),
      eta: r.estimated_days
    }));

    res.json({ rates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   3️⃣ CREATE STRIPE CHECKOUT
====================================================== */
app.post("/api/checkout", async (req, res) => {
  try {
    const { rateId } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: "Shipping Charge" },
          unit_amount: Math.round(req.body.amount * 100)
        },
        quantity: 1
      }],
      metadata: { rateId },
      success_url: `${BASE_URL}/success.html`,
      cancel_url: `${BASE_URL}/cancel.html`
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   4️⃣ STRIPE WEBHOOK → BUY LABEL
====================================================== */
app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    if (event.type === "checkout.session.completed") {
      const rateId = event.data.object.metadata.rateId;

      await shippoFetch("/transactions/", {
        method: "POST",
        body: JSON.stringify({
          rate: rateId,
          label_file_type: "PDF",
          async: false
        })
      });
    }

    res.json({ received: true });
  } catch (err) {
    res.status(400).send("Webhook error");
  }
});

/* ======================
   START
====================== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
