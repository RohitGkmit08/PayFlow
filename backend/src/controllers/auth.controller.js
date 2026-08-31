const { registerSchema, loginSchema } = require("../validator/auth.validator.js");

const bcrypt = require("bcrypt");

const User = require("../models/User.js");

const Account = require("../models/Accounts.js");

const Wallet = require("../models/Wallet.js");

const mongoose = require("mongoose");

const crypto = require("crypto");

const Session = require("../models/Session.js");

//Request ---> Zod validation ---> Existing user check ---> Password hashing ---> Create User

const register = async (req, res) => {
    try {
        const result = registerSchema.safeParse(req.body);
        // this gives us validated data (req.body --> registerSchema --> "is this data valid")

        // parse()
        // ├── valid   → returns data
        // └── invalid → throws error

        // safeParse()
        // ├── valid   → { success: true, data }
        // └── invalid → { success: false, error }

        if (!result.success) {
            return res.status(400).json({
                message: "invalid registration data",
                errors: result.error.issues
            });
        }

        const { name, phone, email, password } = result.data;

        const existingUser = await User.findOne(
            email ? { $or: [{ phone }, { email }] } : { phone }
        );

        if (existingUser) {
            return res.status(409).json({
                message: "User already exists"
            });
        }

        const passwordHash = await bcrypt.hash(password, 8);
        //  We compare the password the user enters now with the hash of the password they created earlier, not hash-to-hash comparison.

        // create User + Account + Wallet (Our registration operation should create three related documents)
        // BEGIN TRANSACTION Create User --> Create Account --> Create Wallet --> Commit, if anything fail, ROLLBACK

        const session = await mongoose.startSession();

        try {
            session.startTransaction();

            // create User
            const users = await User.create(
                [
                    {
                        name,
                        email,
                        phone,
                        hashPswd: passwordHash
                    }
                ], { session }
            );

            const user = users[0];

            // create Account
            const accounts = await Account.create(
                [
                    {
                        userId: user._id,
                        accountType: 'USER_WALLET',
                        currency: 'INR',
                        status: 'ACTIVE',
                    }
                ], { session });

            const account = accounts[0];

            // create Wallet
            await Wallet.create(
                [
                    {
                        userId: user._id,
                        accountId: account._id,
                        availableBalance: 0
                    }
                ], { session });

            // everything succeeded, then commit

            await session.commitTransaction();

            return res.status(201).json({
                message: "User registered successfully",
                user: {
                    id: user._id,
                    name: user.name,
                    phone: user.phone,
                    email: user.email
                }
            });

        } catch (err) {

            await session.abortTransaction();
            throw err;

        } finally {
            session.endSession();
        }

    } catch (err) {

        return res.status(500).json({
            message: "internal server error"
        });

    }
};

// req.body --> Zod validation --> find user --> user exists? --> check account status --> bcrypt.compare() --> create session --> httpOnly cookie
const login = async (req, res) => {

    try {

        const result = loginSchema.safeParse(req.body);
        if (!result.success) {
            return res.status(400).json({
                message: "invalid login data",
                errors: result.error.issues
            });

        }

        const { email, password } = result.data;
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({
                message: "invalid email or password"
            });
        }
        if(user.status === "BLOCKED"){
            return res.status(403).json({
                message: "account is blocked"
            })
        }

        const isPasswordValid = await bcrypt.compare(password, user.hashPswd);

        if(!isPasswordValid){
            return res.status(401).json({
                message: "invalid email or password"
            })
        }

        // After successful login, we generate a cryptographically random session token, and create a record in our sessions collection.
        // The session token acts as a secret credential that represents an authenticated session belonging to a specific user.
        // The server sends the raw session token to the browser using an HttpOnly cookie., The browser stores the cookie and automatically sends it with future requests.
        // On each future request, the server uses the session token to find the corresponding session, which gives us the userId and allows us to identify the authenticated user.

        // Cookie --> raw session token --> hash token --> find session --> session.userId --> user.

        const sessionToken = crypto.randomBytes(32).toString("hex");
        // 32 random bytes becomes 64-chtr hexadecimal string.
        // these are generated by server, and acts as a credential for this login session.

        const sessionTokenHash = crypto.createHash("sha256").update(sessionToken).digest("hex")
        // raw session token --> SHA-256 --> session token hash --> store in mongoDb.
        // raw session token --> HttpOnly cookie --> Browser.

        await Session.create({
            userId: user._id,
            sessionTokenHash,
            expiresAt: new Date(Date.now() + 7*24*60*60*1000)
            // (*1000) because JS timestamps are measured in miliseconds.
        })

        res.cookie("sessionToken", sessionToken, {
            httpOnly:true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 7 * 24 * 60 * 60 * 1000,
        })

        return res.status(200).json({
            message: "login successful",
            user: {
                id: user._id,
                name: user.name,
                phone: user.phone,
                email: user.email
            }
        })
    } catch (err) {
        return res.status(500).json({
            message: "internal server error"
        });
    }

};

const getMe = async (req, res) => {
    try {
        const user = await User.findById(req.userId).select(
            "-hashPswd"
        );

        if (!user) {
            return res.status(404).json({
                message: "User not found"
            });
        }

        return res.status(200).json({
            user: {
                id: user._id,
                name: user.name,
                phone: user.phone,
                email: user.email,
                status: user.status
            }
        });

    } catch (err) {

        return res.status(500).json({
            message: "Internal server error"
        });

    }
};
module.exports = { register, login, getMe };