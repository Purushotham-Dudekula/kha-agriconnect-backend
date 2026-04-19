const express = require("express");
const { protectAdmin } = require("../middleware/adminAuth.middleware");
const { requireSuperAdmin } = require("../middleware/admin.middleware");
const { validate } = require("../middleware/validate.middleware");
const adminValidation = require("../validations/admin.validation");
const {
  createAdmin,
  bootstrapSuperAdmin,
  deactivateAdmin,
  listAdmins,
  listAdminActivity,
} = require("../controllers/admin.controller");

const router = express.Router();

router.post(
  "/bootstrap",
  protectAdmin,
  requireSuperAdmin,
  validate(adminValidation.adminUserBody),
  bootstrapSuperAdmin
);
router.post("/create-admin", protectAdmin, requireSuperAdmin, validate(adminValidation.adminUserBody), createAdmin);
router.get("/admins", protectAdmin, requireSuperAdmin, listAdmins);
router.get("/admin-activity", protectAdmin, requireSuperAdmin, listAdminActivity);
router.patch(
  "/deactivate-admin/:id",
  protectAdmin,
  requireSuperAdmin,
  validate(adminValidation.paramId, "params"),
  deactivateAdmin
);

module.exports = router;
