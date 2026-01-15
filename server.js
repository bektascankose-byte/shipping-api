import express from "express";
import cors from "cors";
import Stripe from "stripe";

const app = express();
app.use(cors());

/* ======================
   SHIPPO REST CONFIG
====================== */
const SHIPPO_BASE = "https://api.goshippo.com";
const SHIPPO_TOKEN = process.env.SHIPPO_API_KEY;

async function shippoFetch(path, options = {}) {
  const res = await fetch(`${SHIPPO_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `ShippoToken ${SHIPPO_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shippo error ${res.status}: ${text}`);
  }

  return res.json();
}

/* ======================
   STRIPE
====================== */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ======================
   STRIPE WEBHOOK (RAW)
====================== */
app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error(err.message);
      return res.status(400).send("Webhook Error");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const { rateId } = session.metadata;

      // ✅ BUY LABEL VIA SHIPPO REST API
      await shippoFetch("/transactions", {
        method: "POST",
        body: JSON.stringify({
          rate: rateId,
          label_file_type: "PDF",
          async: false
        })
      });
    }

    res.json({ received: true });
  }
);

/* ======================
   JSON + STATIC FILES
====================== */
app.use(express.json());
app.use(express.static("public"));

/* ======================
   GET SHIPPING RATES
====================== */
app.get("/api/shipping/:orderToken", async (req, res) => {
  try {
    const order = await shippoFetch(`/orders/${req.params.orderToken}`);

    if (!order.shipments || !order.shipments.length) {
      return res.status(404).json({ error: "No shipment found" });
    }

    const shipment = await shippoFetch(`/shipments/${order.shipments[0]}`);

    const rates = shipment.rates.map(r => ({
      rate_id: r.object_id,
      carrier: r.provider,
      service: r.servicelevel.name,
      amount: Number(r.amount),
      eta: r.estimated_days
    }));

    res.json({
      customer: {
        name: order.to_address?.name,
        city: order.to_address?.city,
        state: order.to_address?.state
      },
      rates
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Failed to load shipping" });
  }
});

/* ======================
   CREATE STRIPE CHECKOUT
====================== */
app.post("/api/checkout", async (req, res) => {
  try {
    const { orderToken, rateId } = req.body;

    const order = await shippoFetch(`/orders/${orderToken}`);
    const shipment = await shippoFetch(`/shipments/${order.shipments[0]}`);

    const rate = shipment.rates.find(r => r.object_id === rateId);
    if (!rate) return res.status(400).json({ error: "Invalid rate" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `Shipping – ${rate.provider} ${rate.servicelevel.name}`
          },
          unit_amount: Math.round(rate.amount * 100)
        },
        quantity: 1
      }],
      metadata: { rateId },
      success_url: `${process.env.BASE_URL}/shipping-success.html`,
      cancel_url: `${process.env.BASE_URL}/shipping-cancelled.html`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Checkout failed" });
  }
});

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
