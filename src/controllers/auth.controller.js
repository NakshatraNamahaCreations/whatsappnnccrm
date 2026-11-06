import User from "../models/User.js";
import ApiError from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { generateToken } from "../utils/generateToken.js";

const publicUser = (u) => ({ id: u._id, name: u.name, email: u.email, role: u.role });

export const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  if (await User.findOne({ email })) throw new ApiError(400, "Email already registered");
  const user = await User.create({ name, email, password });
  res.status(201).json({ token: generateToken(user._id), user: publicUser(user) });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select("+password");
  if (!user || !(await user.comparePassword(password))) throw new ApiError(401, "Invalid credentials");
  res.json({ token: generateToken(user._id), user: publicUser(user) });
});

export const me = asyncHandler(async (req, res) => res.json(publicUser(req.user)));
