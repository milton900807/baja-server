const axios = require("axios");

// Base URL of your Express server
const BASE_URL = "http://localhost:8080/api";

// Helper function to log results
function logResult(action, result) {
  console.log(`\n=== ${action} ===`);
  console.log(result.data || result.message || result);
}

// Test: Create a product
async function testCreateProduct() {
  try {
    const response = await axios.post(`${BASE_URL}/create-product`);
    logResult("Product Created", response.data);
    return response.data.id; // Return product ID for further testing
  } catch (error) {
    console.error("Error creating product:", error.response?.data || error.message);
  }
}

// Test: Create a product
async function testUserdb(planId) {
  try {
    const response = await axios.post(`${BASE_URL}/download-active-users`, {
      planId,
    });
    logResult("Active subscriptions: ", response.data);
    return response.data.id; // Return product ID for further testing
  } catch (error) {
    console.error("Error downloading users:", error.response?.data || error.message);
  }
}

// Test: User payment submission
async function testUserPayment(userId) {
  try {
    const response = await axios.post(`${BASE_URL}/user/payment`, {
      userId,
    });
    logResult("User Payment Successful", response.data);
  } catch (error) {
    console.error("Error during user payment:", error.response?.data || error.message);
  }
}
// Test: Create a subscription plan
async function testCreatePlan(productId) {
  try {
    const response = await axios.post(`${BASE_URL}/create-plan`, {
      productId,
    });
    logResult("Plan Created", response.data);
    return response.data.id; // Return plan ID for further testing
  } catch (error) {
    console.error("Error creating plan:", error.response?.data || error.message);
  }
}

// Test: Activate a plan
async function testActivatePlan(planId) {
  try {
    const response = await axios.post(`${BASE_URL}/activate-plan`, {
      planId,
    });
    logResult("Plan Activated", response.data);
  } catch (error) {
    console.error("Error activating plan:", error.response?.data || error.message);
  }
}

// Test: Check user subscription
async function testCheckSubscription(userId, planId) {
  try {
    const response = await axios.post(`${BASE_URL}/check-license`, {
      userId,
      planId,
    });
    logResult("Subscription Check Successful", response.data);
  } catch (error) {
    console.error("Error checking subscription:", error.response?.data || error.message);
  }


}

// Test: List available plans for a product
async function testListAvailablePlans(productId) {
  try {
    const response = await axios.get(`${BASE_URL}/list-plans`, {
      params: { productId },
    });
    logResult("Available Plans", response.data);
    return response.data.plans; // Return the list of plans for further processing if needed
  } catch (error) {
    console.error("Error listing available plans:", error.response?.data || error.message);
  }
}




// Main test flow
async function runTests() {
  console.log("Starting PayPal API Tests...");
  // // Step 1: Create a product
  const prod = 'PROD-1SB740112K441822A'
  const planId = 'P-7XR50227TE2246924M6H3GTI'
  await testListAvailablePlans(prod)
  await testUserdb (planId)
}

// Run tests
runTests();
