const express = require("express");

const router = express.Router();

const {
  authMiddleware,
  authorize
} = require("../middleware/authMiddleware");

const inventoryController = require("../controllers/inventoryController");

router.get("/", authMiddleware, inventoryController.getAllItems);

router.post("/", authMiddleware, inventoryController.addItem);

router.get(
  "/recipe/:menuItemId",
  authMiddleware,
  inventoryController.getRecipe
);

router.post(
  "/recipe/:menuItemId",
  authMiddleware,
  authorize("manager","kitchen"),
  inventoryController.addRecipeIngredient
);

router.patch(
  "/recipe/ingredient/:id",
  authMiddleware,
  authorize("manager","kitchen"),
  inventoryController.updateRecipeIngredient
);

router.delete(
  "/recipe/ingredient/:id",
  authMiddleware,
  authorize("manager","kitchen"),
  inventoryController.deleteRecipeIngredient
);

router.get(
  "/dashboard",
  authMiddleware,
  inventoryController.getDashboard
);

router.put(
  "/:id",
  authMiddleware,
  authorize("manager"),
  inventoryController.updateItem
);

router.post(
  "/:id/transaction",
  authMiddleware,
  authorize("manager"),
  inventoryController.addTransaction
);

router.get(
  "/:id/transactions",
  authMiddleware,
  inventoryController.getTransactions
);

router.patch(
  "/:id/deactivate",
  authMiddleware,
  authorize("manager"),
  inventoryController.deactivateItem
);

router.patch(
  "/:id/activate",
  authMiddleware,
  authorize("manager"),
  inventoryController.activateItem
);

module.exports = router;