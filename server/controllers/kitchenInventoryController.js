const kitchenInventoryModel = require("../models/kitchenInventoryModel");

// ======================================================
// GET KITCHEN STOCK
// GET /api/kitchen-inventory
// ======================================================

exports.getKitchenStock = async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;

    const stock =
      await kitchenInventoryModel.getKitchenStock(restaurantId);

    res.json({ success: true, data: stock });

  } catch (error) {
    console.error("getKitchenStock:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// ======================================================
// CREATE DEMAND REQUEST
// POST /api/kitchen-inventory/requests
// body: { inventory_id, requested_quantity, note }
// ======================================================

exports.createRequest = async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const { inventory_id, requested_quantity, note } = req.body;

    if (!inventory_id || requested_quantity === undefined) {
      return res.status(400).json({
        success: false,
        message: "inventory_id and requested_quantity are required"
      });
    }

    const request = await kitchenInventoryModel.createRequest({
      restaurant_id: restaurantId,
      inventory_id: Number(inventory_id),
      requested_quantity,
      note: note || null,
      requested_by: req.user.id
    });

    res.status(201).json({ success: true, data: request });

  } catch (error) {
    console.error("createRequest:", error);
    res.status(400).json({
      success: false,
      message: error.message || "Unable to create request"
    });
  }
};

// ======================================================
// GET REQUESTS
// GET /api/kitchen-inventory/requests?status=pending
// ======================================================

exports.getRequests = async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const status = req.query.status || "all";

    const allowedStatus = ["all", "pending", "approved", "rejected"];

    if (!allowedStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status filter"
      });
    }

    const requests =
      await kitchenInventoryModel.getRequests(restaurantId, status);

    res.json({ success: true, data: requests });

  } catch (error) {
    console.error("getRequests:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// ======================================================
// APPROVE REQUEST
// PUT /api/kitchen-inventory/requests/:id/approve
// ======================================================

exports.approveRequest = async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const { id } = req.params;

    const request = await kitchenInventoryModel.approveRequest(
      id,
      restaurantId,
      req.user.id
    );

    const io = req.app.get("io");
    if (io) {
      io.to(`restaurant_${restaurantId}`).emit("kitchen_inventory_updated");
    }

    res.json({ success: true, data: request });

  } catch (error) {
    console.error("approveRequest:", error);
    res.status(400).json({
      success: false,
      message: error.message || "Unable to approve request"
    });
  }
};

// ======================================================
// REJECT REQUEST
// PUT /api/kitchen-inventory/requests/:id/reject
// body: { reason }
// ======================================================

exports.rejectRequest = async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const { id } = req.params;
    const { reason } = req.body;

    const request = await kitchenInventoryModel.rejectRequest(
      id,
      restaurantId,
      req.user.id,
      reason || null
    );

    const io = req.app.get("io");
    if (io) {
      io.to(`restaurant_${restaurantId}`).emit("kitchen_inventory_updated");
    }

    res.json({ success: true, data: request });

  } catch (error) {
    console.error("rejectRequest:", error);
    res.status(400).json({
      success: false,
      message: error.message || "Unable to reject request"
    });
  }
};
