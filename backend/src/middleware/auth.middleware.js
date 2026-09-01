const crypto = require("crypto");

const Session = require("../models/Session.js")

const authMiddleware = async(req, res, next) => {
    try{
        const {sessionToken} = req.cookies;
        if(!sessionToken){
            return res.status(401).json({
                message: "Authentication required"
            })
        }

        const sessionTokenHash = crypto
        .createHash("sha256")
        .update(sessionToken)
        .digest("hex") 

        const session = await Session.findOne({sessionTokenHash});

        // if session is found, then mongoDb might return -
        // session = {
        //     _id: "...",
        //     userId: "64abc...",
        //     sessionTokenHash: "...",
        //     expiresAt: "...",
        //     revokedAt: null
        // }

        // session.userId = "6523adcsd.......", so, this is the ID of the user who owns this session
        if(!session){
            return res.status(401).json({
                message: "invalid session"
            })
        }

        if (session.expiresAt < new Date()) {
            return res.status(401).json({
                message: "session expired"
            });
        }

        // so we are taking session.userId and attach it to req.userId, now the request now carries the authenticated user's identity.

        req.userId = session.userId;

        // now - 
            // req
            // ├── cookies
            // ├── headers
            // ├── body
            // ├── ...
            // └── userId = "64abc..."

        next();
        // now the controller can access : req.userId
    }catch(err){
        return res.status(500).json({
            message: "internal server error"
        })
    }
}

module.exports = authMiddleware;