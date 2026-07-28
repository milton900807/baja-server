import express, { Request, Response } from "express";
import {
  getPayPalAccessToken,
  createProduct,
  createPlan,
  activatePlan,
  getActiveUsers,
  listPlansForProduct,
} from "./license";

const router = express.Router();

router.post("/create-product", async (_req: Request, res: Response) => {
  try {
    const accessToken = await getPayPalAccessToken();
    const product = await createProduct(accessToken);
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List plans for a product
router.get("/list-plans", async (req: Request, res: Response) => {
  const { productId } = req.query;

  if (!productId) {
    return res.status(400).json({ error: "Product ID is required" });
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const plans = await listPlansForProduct(accessToken, productId as string);
    res.json({ plans });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/create-plan", async (req: Request, res: Response) => {
  const { productId } = req.body;

  try {
    const accessToken = await getPayPalAccessToken();
    const plan = await createPlan(accessToken, productId);
    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});




router.post("/activate-plan", async (req: Request, res: Response) => {
  const { planId } = req.body;

  try {
    const accessToken = await getPayPalAccessToken();
    const response = await activatePlan(accessToken, planId);
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


router.post("/download-active-users", async (req: Request, res: Response) => {
  const { planId } = req.body;

  try {
    const activeUsers = await getActiveUsers(planId);
    res.json(activeUsers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


router.post("/user/payment", async (req, res) => {
  const { userId } = req.body; // Assumes userId is sent in the request body
  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }
  try {
    // Step 1: Get PayPal Access Token
    const accessToken = await getPayPalAccessToken();
    // Step 2: Create a PayPal Product
    const product = await createProduct(accessToken);
    console.log("Product created:", product);

    // Step 3: Create a Subscription Plan for the Product
    const plan = await createPlan(accessToken, product.id);
    console.log("Plan created:", plan);

    // Step 4: Activate the Subscription Plan
    await activatePlan(accessToken, plan.id);
    console.log("Plan activated successfully");

    // Step 5: Respond with success message and details
    return res.status(200).json({
      message: "Subscription plan created and activated successfully",
      product,
      plan,
    });
  } catch (error) {
    console.error("Error handling user payment:", error);
    return res.status(500).json({ error: "Failed to handle user payment" });
  }
});




export default router;
