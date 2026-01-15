import express from "express";
import cors from "cors";
import Stripe from "stripe";

/* ======================
   BASIC APP SETUP
====================== */
const app = express();
app.use(cors());

// Health check (prevents "Cannot GET /" confusion)
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "shipping-api",
    time: new Date().toISOString()
  });
});

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
   STRIPE CONFIG
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
      console.error("Webhook verification failed:", err.message);
      return res.status(400).send("Webhook Error");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const { rateId } = session.metadata;

      try {
        // Buy shipping label via Shippo REST API
        await shippoFetch("/transactions", {
          method: "POST",
          body: JSON.stringify({
            rate: rateId,
            label_file_type: "PDF",
            async: false
          })
        });
      } catch (err) {
        console.error("Shippo label purchase failed:", err.message);
      }
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
    const orderToken = req.params.orderToken;

    // 1. Fetch Shippo order
    const order = await shippoFetch(`/orders/${orderToken}`);

    if (!order.shipments || order.shipments.length === 0) {
      return res.status(400).json({
        error: "Order has no shipments. Ensure parcels were added."
      });
    }

    // 2. Fetch shipment
    const shipmentId = order.shipments[0];
    const shipment = await shippoFetch(`/shipments/${shipmentId}`);

    // 3. Extract rates
    const rates = shipment.rates.map(r => ({
      rate_id: r.object_id,
      carrier: r.provider,
      service: r.servicelevel.name,
      amount: Number(r.amount),
      eta: r.estimated_days
    }));

    res.json({
      customer: {
        name: order.to_address?.name || "Customer",
        city: order.to_address?.city,
        state: order.to_address?.state
      },
      rates
    });
  } catch (err) {
    console.error("Shipping fetch error:", err.message);
    res.status(500).json({
      error: "Failed to load shipping rates",
      details: err.message
    });
  }
});

/* ======================
   CREATE STRIPE CHECKOUT
====================== */
app.post("/api/checkout", async (req, res) => {
  try {
    const { orderToken, rateId } = req.body;

    if (!orderToken || !rateId) {
      return res.status(400).json({ error: "Missing orderToken or rateId" });
    }

    // Re-fetch order & shipment to prevent tampering
    const order = await shippoFetch(`/orders/${orderToken}`);
    const shipment = await shippoFetch(`/shipments/${order.shipments[0]}`);

    const rate = shipment.rates.find(r => r.object_id === rateId);
    if (!rate) {
      return res.status(400).json({ error: "Invalid rate selected" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Shipping – ${rate.provider} ${rate.servicelevel.name}`
            },
            unit_amount: Math.round(Number(rate.amount) * 100)
          },
          quantity: 1
        }
      ],
      metadata: { rateId },
      success_url: `${process.env.BASE_URL}/shipping-success.html`,
      cancel_url: `${process.env.BASE_URL}/shipping-cancelled.html`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err.message);
    res.status(500).json({
      error: "Checkout failed",
      details: err.message
    });
  }
});

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
