const { promisify } = require("util");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const User = require("../models/userModel");

const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

const createSendToken = (user, statusCode, req, res) => {
  const token = signToken(user._id);

  res.cookie("jwt", token, {
    expiresIn: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
  });

  // Remove password from output
  user.password = undefined;
  res.status(statusCode).json({
    status: "success",
    token,
    data: {
      user,
    },
  });
};

const signup = async (req, res, next) => {
  try {
    const user = await User.create({
      name: req.body.name,
      email: req.body.email,
      address: req.body.address,
      dob: req.body.dob,
      role: req.body.role,
      password: req.body.password,
    });

    if (!user) {
      return res
        .status(400)
        .json({ status: "failed", msg: `can not sign up the user` });
    }
    createSendToken(user, 201, req, res);
  } catch (error) {
    return res.status(400).json({ status: "failed", msg: error });
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(401).json({
        status: "failed",
        msg: "Please provide email and password!",
      });
    }
    const user = await User.findOne({ email }).select("+password");
    if (!user || !(await user.checkPassword(password, user.password))) {
      return res.status(401).json({
        status: "failed",
        msg: "Incorrect email or password",
      });
    }
    createSendToken(user, 200, req, res);
  } catch (error) {
    return res.status(401).json({
      status: "failed",
      msg: error,
    });
  }
};

const logout = (req, res) => {
  try {
    res.cookie("jwt", "loggedout", {
      expires: new Date(Date.now() + 10 * 100),
      httpOnly: true,
    });
    res.status(200).json({
      status: "success",
      message: "Successfully logged out of your account",
    });
  } catch (error) {
    res.status(402).json({
      status: "failed",
      message: "Can not log out if you are not logged in",
    });
  }
};

const protect = async (req, res, next) => {
  try {
    let token;
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.cookies.jwt;
    }
    if (!token) {
      return next(
        res.status(401).json({
          status: "Invalid Token",
          message: "Auth failed, Please provide a valid token",
        })
      );
    }
    const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);
    const currentUser = await User.findById(decoded.id);
    if (!currentUser) {
      return res.status(404).json({
        status: "failed",
        message: "User does not exist",
      });
    }
    req.user = currentUser;
    next();
  } catch (error) {
    return res.status(500).json({
      status: "failed",
      message: "Route protection failed",
      error: error,
    });
  }
};

const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(401).json({
        status: "Missing roles",
        message: "You do not have permissions to perform this action",
      });
    }
    next();
  };
};

const forgotPassword = async (req, res, next) => {
  // 1) Get user based on email
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(
      res.status(404).json({
        status: "Failed",
        message: `No user found with this email address : ${req.body.email}`,
      })
    );
  }

  // 2) Generate the random reset token
  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });

  // 3) Send it to user's email
  try {
    const resetURL = `${req.protocol}://${req.get(
      "host"
    )}/api/v1/users/resetPassword/${resetToken}`;
    await new Email(user, resetURL).sendPasswordReset();

    res.status(200).json({
      status: "success",
      message: "Token sent to email!",
    });
  } catch (err) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });

    return next(
      res.status(404).json({
        status: "Failed",
        message: `No user found with this email address : ${req.body.email}`,
      })
    );
  }
};

const resetPassword = async (req, res, next) => {
  try {
    // 1) Get user based on the token
    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    });

    // 2) If token has not expired, and there is user, set the new password
    if (!user) {
      return next(
        res.status(404).json({
          status: "Failed",
          message: `No user found`,
        })
      );
    }
    user.password = req.body.password;
    user.passwordConfirm = req.body.passwordConfirm;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    // 3) Log the user in, send JWT
    createSendToken(user, 200, req, res);
  } catch (error) {
    res.status(500).json({
      status: "Failed",
      error: error,
    });
  }
};

module.exports = {
  signup,
  login,
  logout,
  protect,
  restrictTo,
  forgotPassword,
  resetPassword,
};