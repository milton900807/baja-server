import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || "";
const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || "";



export async function getPayPalAccessToken(): Promise<string> {
    try {

        const base64Credentials = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");
        const response = await axios.post(
            `${PAYPAL_API_BASE}/v1/oauth2/token`,
            "grant_type=client_credentials",
            {
                headers: {
                    Authorization: `Basic ${base64Credentials}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            }
        );
        return response.data.access_token;
    } catch (error) {
        console.error("Error fetching PayPal access token:", error.response?.data || error.message);
        throw new Error("Failed to get PayPal access token");
    }
}


// // Get PayPal access token
// export async function getPayPalAccessToken(): Promise<string> {
//   try {
//     const response = await axios.post(
//       `${PAYPAL_API_BASE}/v1/oauth2/token`,
//       "grant_type=client_credentials",
//       {
//         headers: {
//           "Content-Type": "application/x-www-form-urlencoded",
//         },
//         auth: {
//           username: PAYPAL_CLIENT_ID,
//           password: PAYPAL_SECRET,
//         },
//       }
//     );
//     return response.data.access_token;
//   } catch (error) {
//     console.error("Error fetching PayPal access token:", error);
//     throw new Error("Failed to get PayPal access token");
//   }
// }


// const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || "";

export async function createProduct(accessToken: string): Promise<any> {
    console.log ( " access token " + accessToken )

    if (!accessToken) {
        accessToken = await this.getPayPalAccessToken()
    }

    try {
        const response = await axios.post(
            `${PAYPAL_API_BASE}/v1/catalogs/products`,
            {
                name: "ptx_analytics",
                description: "Analytics platform for precision therapeutics",
                type: "SERVICE",
                category: "SOFTWARE",
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
            }
        );
        return response.data;
    } catch (error: any) {
        // Log detailed error information
        if (error.response) {
            console.error("Error creating product:", {
                status: error.response.status,
                data: error.response.data,
            });
        } else {
            console.error("Error creating product:", error.message);
        }

        // Throw a more descriptive error
        throw new Error(
            `Failed to create product: ${error.response?.data?.message || error.message
            }`
        );
    }
}




// Create a subscription plan
export async function createPlan(
    accessToken: string,
    productId: string
) {
    try {
        const response = await axios.post(
            `${PAYPAL_API_BASE}/v1/billing/plans`,
            {
                product_id: productId,
                name: "12-Month PTX_Analytics Subscription",
                description: "12-month subscription for PTX_Analytics platform",
                billing_cycles: [
                    {
                        frequency: {
                            interval_unit: "YEAR",
                            interval_count: 1,
                        },
                        tenure_type: "REGULAR",
                        sequence: 1,
                        total_cycles: 0,
                        pricing_scheme: {
                            fixed_price: {
                                value: "200.00",
                                currency_code: "USD",
                            },
                        },
                    },
                ],
                payment_preferences: {
                    auto_bill_outstanding: true,
                    setup_fee: {
                        value: "0.00",
                        currency_code: "USD",
                    },
                    setup_fee_failure_action: "CONTINUE",
                    payment_failure_threshold: 3,
                },
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
            }
        );
        return response.data;
    } catch (error) {
        console.error("Error creating subscription plan:", error);
        throw new Error("Failed to create subscription plan");
    }
}

// Activate a subscription plan
export async function activatePlan(accessToken: string, planId: string) {
    try {
        await axios.post(
            `${PAYPAL_API_BASE}/v1/billing/plans/${planId}/activate`,
            {},
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );
        return { message: "Plan activated successfully" };
    } catch (error) {
        console.error("Error activating plan:", error);
        throw new Error("Failed to activate plan");
    }
}

export async function listPlansForProduct(accessToken: string, productId: string) {
    const url = `${PAYPAL_API_BASE}/v1/billing/plans`;

    const response = await axios.get(`${url}`, {

      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      params: {
        product_id: productId,
      },
    });
    return response.data.plans; // Adjust based on PayPal API's response
  }
  export async function getActiveUsers(planId: string): Promise<any[]> {
    try {
        const accessToken = await getPayPalAccessToken();

        console.log ( " acces token " + accessToken )

        const response = await axios.post(
            `${PAYPAL_API_BASE}/v1/billing/subscriptions`, // Updated to a hypothetical POST endpoint
            {
                plan_id: planId,
                status: 'ACTIVE',
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        return response.data.subscriptions; // Adjust this based on the expected API response structure
    } catch (error) {
        console.error("Error fetching active users:", error.message);
        throw error;
    }
}


export async function saveActiveUsersToFile(planId: string, fileName: string): Promise<void> {
    try {
        const activeUsers = await getActiveUsers(planId);
        const fs = await import("fs");
        const filePath = `./${fileName}`;

        fs.writeFileSync(filePath, JSON.stringify(activeUsers, null, 2));
        console.log(`Active users saved to ${filePath}`);
    } catch (error) {
        console.error("Error saving active users to file:", error);
        throw error;
    }
}
