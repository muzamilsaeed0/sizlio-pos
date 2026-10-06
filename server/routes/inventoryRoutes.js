const express = require("express");

const router = express.Router();

const {
  authMiddleware,
  authorize
} = require("../middleware/authMiddleware");

const inventoryController = require("../controllers/inventoryController");

router.get("/", authMiddleware, authorize("manager", "counter", "kitchen"), inventoryController.getAllItems);

router.post("/", authMiddleware, authorize("manager", "counter"), inventoryController.addItem);

router.get(
  "/recipe/:menuItemId",
  authMiddleware,
  authorize("manager", "counter", "kitchen"),
  inventoryController.getRecipe
);

router.post(
  "/recipe/:menuItemId",
  authMiddleware,
  authorize("manager","counter","kitchen"),
  inventoryController.addRecipeIngredient
);

router.patch(
  "/recipe/ingredient/:id",
  authMiddleware,
  authorize("manager","counter","kitchen"),
  inventoryController.updateRecipeIngredient
);

router.delete(
  "/recipe/ingredient/:id",
  authMiddleware,
  authorize("manager","counter","kitchen"),
  inventoryController.deleteRecipeIngredient
);

router.get(
  "/dashboard",
  authMiddleware,
  authorize("manager", "counter"),
  inventoryController.getDashboard
);

router.get(
  '/list-for-purchase',
   authMiddleware,
   authorize("manager", "counter"),
    inventoryController.listForPurchase
  );

router.put(
  "/:id",
  authMiddleware,
  authorize("manager", "counter"),
  inventoryController.updateItem
);

router.post(
  "/:id/transaction",
  authMiddleware,
  authorize("manager", "counter"),
  inventoryController.addTransaction
);

router.get(
  "/:id/transactions",
  authMiddleware,
  authorize("manager", "counter"),
  inventoryController.getTransactions
);

router.patch(
  "/:id/deactivate",
  authMiddleware,
  authorize("manager", "counter"),
  inventoryController.deactivateItem
);

router.patch(
  "/:id/activate",
  authMiddleware,
  authorize("manager", "counter"),
  inventoryController.activateItem
);

module.exports = router;