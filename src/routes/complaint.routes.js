const express = require("express");
const { protect } = require("../middleware/auth.middleware");
const { createComplaint, listMyComplaints } = require("../controllers/complaint.controller");

const router = express.Router();

router.post("/", protect, createComplaint);
router.get("/", protect, listMyComplaints);

module.exports = router;
