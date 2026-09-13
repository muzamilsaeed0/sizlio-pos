cd ~/sizlio-pos/server

cat > services/emailService.js << 'ENDOFFILE'
const { Resend } = require("resend");

// =====================================================
// RESEND CLIENT
// =====================================================

const resend = new Resend(process.env.RESEND_API_KEY);

// =====================================================
// FROM ADDRESS
// =====================================================

const FROM_ADDRESS =
  process.env.EMAIL_FROM ||
  "Sizlio POS <onboarding@resend.dev>";

// =====================================================
// GET BASE URL
// =====================================================

function getBaseUrl() {
  const url =
    process.env.PUBLIC_URL ||
    process.env.APP_URL ||
    `http://localhost:${process.env.PORT || 3000}`;
  return url.replace(/\/+$/, "");
}

// =====================================================
// ROLE LOGIN URL WITH RESTAURANT ID
// =====================================================

function getLoginUrl(role, restaurantId) {
  const baseUrl = getBaseUrl();

  const pages = {
    manager: "manager.html",
    waiter: "waiter.html",
    kitchen: "kitchen.html",
    counter: "counter.html",
    display: "display.html",
    delivery: "rider.html",
    rider: "rider.html",
    delivery_rider: "rider.html"
  };

  const page = pages[role];
  if (!page) {
    throw new Error(`Unknown login role: ${role}`);
  }

  const url = `${baseUrl}/${page}`;
  if (restaurantId) {
    return `${url}?restaurant=${restaurantId}`;
  }

  return url;
}

// =====================================================
// SEND RESTAURANT CREDENTIALS
// =====================================================

const sendRestaurantCredentials = async ({
  restaurant,
  manager,
  staff
}) => {

  const managerLoginUrl = getLoginUrl("manager", restaurant.id);

  const roleNames = {
    waiter: "Waiter",
    kitchen: "Kitchen",
    counter: "Counter",
    display: "Display",
    rider: "Delivery",
    delivery: "Delivery",
    delivery_rider: "Delivery"
  };

  const staffSections = [];

  for (const role of Object.keys(staff || {})) {
    const accounts = staff[role];
    if (!Array.isArray(accounts) || !accounts.length) {
      continue;
    }

    const loginRole = (role === "rider" || role === "delivery_rider") ? "delivery" : role;
    const roleTitle = roleNames[role] || (role.charAt(0).toUpperCase() + role.slice(1));

    const loginUrl = getLoginUrl(loginRole, restaurant.id);

    staffSections.push(`
      <div style="margin-top:30px;padding:22px;border:1px solid #e5e7eb;border-radius:12px;background:#ffffff;">
        <h3 style="margin:0 0 10px 0;color:#111827;">${escapeHtml(roleTitle)} Accounts</h3>

        <div style="background:#f3f4f6;padding:12px 14px;border-radius:8px;margin-bottom:15px;">
          <strong>${escapeHtml(roleTitle)} Login URL</strong><br>
          <a href="${escapeAttribute(loginUrl)}" style="color:#2563eb;text-decoration:none;word-break:break-all;">
            ${escapeHtml(loginUrl)}
          </a>
          <br><br>
          <a href="${escapeAttribute(loginUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:9px 16px;border-radius:7px;text-decoration:none;font-weight:bold;">
            Open ${escapeHtml(roleTitle)} Login
          </a>
        </div>

        <table cellpadding="10" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb;">
          <tr style="background:#f9fafb;">
            <th align="left" style="border-bottom:1px solid #e5e7eb;">Username</th>
            <th align="left" style="border-bottom:1px solid #e5e7eb;">Password</th>
          </tr>
          ${accounts.map(account => `
            <tr>
              <td style="border-bottom:1px solid #e5e7eb;">${escapeHtml(account.username)}</td>
              <td style="border-bottom:1px solid #e5e7eb;font-weight:bold;">${escapeHtml(account.password)}</td>
            </tr>
          `).join("")}
        </table>
      </div>
    `);
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
      <div style="max-width:720px;margin:30px auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

        <div style="background:#111827;color:#ffffff;padding:25px;text-align:center;">
          <h1 style="margin:0;font-size:24px;">Sizlio POS</h1>
          <p style="margin:7px 0 0;color:#d1d5db;">Account Details</p>
        </div>

        <div style="padding:30px;">
          <h2 style="margin-top:0;color:#111827;">Restaurant Created Successfully</h2>
          <p style="line-height:1.6;">
            Your Sizlio POS account has been created successfully.
            Below you will find all login details for your restaurant.
          </p>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:25px 0;">

          <h3>Restaurant Details</h3>
          <table cellpadding="10" style="width:100%;border-collapse:collapse;">
            <tr>
              <td>Restaurant</td>
              <td><strong>${escapeHtml(restaurant.name)}</strong></td>
            </tr>
            <tr>
              <td>Plan</td>
              <td><strong>${escapeHtml(restaurant.plan || "-")}</strong></td>
            </tr>
            <tr>
              <td>Expiry</td>
              <td><strong>${escapeHtml(restaurant.expiry_date ? new Date(restaurant.expiry_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-")}</strong></td>
            </tr>
          </table>

          <div style="margin-top:30px;padding:22px;border:1px solid #e5e7eb;border-radius:12px;">
            <h3 style="margin-top:0;">Manager Account</h3>

            <div style="background:#f3f4f6;padding:12px;border-radius:8px;margin-bottom:15px;">
              <strong>Manager Login URL</strong><br>
              <a href="${escapeAttribute(managerLoginUrl)}" style="color:#2563eb;word-break:break-all;">
                ${escapeHtml(managerLoginUrl)}
              </a>
              <br><br>
              <a href="${escapeAttribute(managerLoginUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:9px 16px;border-radius:7px;text-decoration:none;font-weight:bold;">
                Open Manager Login
              </a>
            </div>

            <table cellpadding="10" style="width:100%;border-collapse:collapse;">
              <tr>
                <td>Username</td>
                <td><strong>${escapeHtml(manager.username)}</strong></td>
              </tr>
              <tr>
                <td>Password</td>
                <td><strong>${escapeHtml(manager.password || "-")}</strong></td>
              </tr>
            </table>
          </div>

          ${staffSections.join("")}

          <div style="margin-top:30px;padding:18px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;">
            <strong>Security Notice</strong>
            <p style="margin-bottom:0;line-height:1.5;">
              Please keep these login credentials secure and do not share them with unauthorized persons.
            </p>
          </div>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0 20px;">

          <p>
            Regards,<br>
            <strong>Sizlio POS</strong>
          </p>

          <p style="font-size:12px;color:#6b7280;">
            This is an automated email. Please do not reply.
          </p>
        </div>

      </div>
    </body>
    </html>
  `;

  // =====================================================
  // SEND VIA RESEND
  // =====================================================

  const result = await resend.emails.send({
    from: FROM_ADDRESS,
    to: restaurant.email,
    subject: `Sizlio POS - ${restaurant.name} Login Details`,
    html
  });

  if (result.error) {
    throw new Error(result.error.message || "Resend API error");
  }

  return result;
};

// =====================================================
// ESCAPE HELPERS
// =====================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

module.exports = {
  sendRestaurantCredentials
};
ENDOFFILE