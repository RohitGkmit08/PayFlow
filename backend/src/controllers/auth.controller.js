const { registerSchema } = require("../validator/auth.validator.js");

const bcrypt = require("bcrypt");

const User = require("../models/User.js");

const Account = require("../models/Account.js");

const Wallet = require("../models/Wallet.js");

const mongoose = require("mongoose");

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

        const existingUser = await User.findOne({
            $or: [{ phone }, { email }]
        });

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
                        passwordHash
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

module.exports = { register };