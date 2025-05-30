"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const auth_service_1 = require("../../services/auth.service");
const errorHandler_1 = require("../middlewares/errorHandler");
const user_service_1 = require("../../services/user.service");
const organization_service_1 = require("../../services/organization.service");
const email_service_1 = require("../../services/email.service");
const crypto_1 = __importDefault(require("crypto"));
const jwt_util_1 = require("../../utils/jwt.util");
class AuthController {
    static async login(req, res, next) {
        console.log("login called");
        try {
            const { email, password, twoFactorToken } = req.body;
            console.log(`Login attempt for email: ${email}, has 2FA token: ${!!twoFactorToken}`);
            const result = await auth_service_1.AuthService.login(email, password, twoFactorToken);
            if (result.requiresTwoFactor) {
                console.log(`2FA required for user: ${email}`);
                res.json({
                    requiresTwoFactor: true,
                    user: {
                        id: result.user.id,
                        email: result.user.email,
                        firstName: result.user.firstName,
                        lastName: result.user.lastName,
                    }
                });
                return;
            }
            // Calculate cookie expiry
            const cookieMaxAge = 24 * 60 * 60 * 1000; // 24 hours
            // Set proper cookie with correct settings for cross-domain
            console.log(`Setting auth cookie for user: ${email}, production mode: ${process.env.NODE_ENV === 'production'}`);
            res.cookie('access_token_w', result.accessToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                maxAge: cookieMaxAge,
                path: '/',
                domain: process.env.NODE_ENV === 'production' ? undefined : undefined // Use domain in production if needed
            });
            console.log(`Login successful for: ${email}`);
            res.json({
                user: result.user,
                accessToken: result.accessToken,
                requiresTwoFactor: false
            });
        }
        catch (error) {
            console.error('Login error:', error);
            next(error); // Pass error to error handler middleware
        }
    }
    ;
    static async loginAdmin(req, res, next) {
        console.log("loginAdmin called");
        try {
            const { email, password } = req.body;
            console.log('Login attempt for admin:', email);
            const result = await auth_service_1.AuthService.loginAdmin(email, password);
            console.log('Login successful for admin:', email);
            res.cookie('access_token_w', result.accessToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'none',
                maxAge: 24 * 60 * 60 * 1000
            });
            res.json(result);
        }
        catch (error) {
            console.error('Admin login error:', error);
            next(error);
        }
    }
    static async refreshToken(req, res, next) {
        try {
            console.log('Token refresh requested');
            // Check for token in cookies first, then body as fallback
            const refreshToken = req.cookies.refresh_token_w || req.body.refreshToken;
            // If no token found, try to use the access token to extend session
            if (!refreshToken) {
                const accessToken = req.cookies.access_token_w;
                if (!accessToken) {
                    console.log('No refresh token or access token provided');
                    return res.status(401).json({
                        success: false,
                        message: 'No refresh token provided'
                    });
                }
                try {
                    // Try to verify and extend current token
                    const decoded = jwt_util_1.JwtUtil.verifyToken(accessToken);
                    // If token is still valid but close to expiry, refresh it
                    const result = await auth_service_1.AuthService.extendSession(decoded.id, decoded.type);
                    // Set new access token cookie
                    res.cookie('access_token_w', result.accessToken, {
                        httpOnly: true,
                        secure: process.env.NODE_ENV === 'production',
                        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                        maxAge: 24 * 60 * 60 * 1000,
                        path: '/'
                    });
                    console.log('Session extended successfully');
                    return res.json({ accessToken: result.accessToken });
                }
                catch (error) {
                    console.log('Failed to extend session with access token');
                    throw new errorHandler_1.AppError(401, 'Invalid token. Please login again');
                }
            }
            // Normal refresh flow with refresh token
            const result = await auth_service_1.AuthService.refreshToken(refreshToken);
            // Set new access token cookie
            res.cookie('access_token_w', result.accessToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                maxAge: 24 * 60 * 60 * 1000,
                path: '/'
            });
            // Optionally set new refresh token cookie if using rolling refresh tokens
            if (result.refreshToken) {
                res.cookie('refresh_token_w', result.refreshToken, {
                    httpOnly: true,
                    secure: process.env.NODE_ENV === 'production',
                    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
                    path: '/'
                });
            }
            console.log('Token refreshed successfully');
            res.json({ accessToken: result.accessToken }); // Only send necessary info back
        }
        catch (error) {
            console.error('Token refresh error:', error);
            next(error);
        }
    }
    static async verifyEmail(req, res, next) {
        try {
            const { token } = req.body;
            await auth_service_1.AuthService.verifyEmail(token);
            res.json({ message: 'Email verified successfully' });
        }
        catch (error) {
            next(error);
        }
    }
    static async verifyToken(req, res, next) {
        var _a;
        try {
            // First try to get token from cookies, then header
            let token;
            if (req.cookies && req.cookies.access_token_w) {
                token = req.cookies.access_token_w;
            }
            else if ((_a = req.headers.authorization) === null || _a === void 0 ? void 0 : _a.startsWith('Bearer ')) {
                token = req.headers.authorization.substring(7);
            }
            // If no token is found, return empty user object (not authenticated)
            if (!token) {
                return res.status(200).json({ user: null, accessToken: null });
            }
            try {
                // Verify the token
                const decoded = jwt_util_1.JwtUtil.verifyToken(token.trim());
                // Get user data
                const user = await auth_service_1.AuthService.getUser(decoded.id, decoded.type);
                return res.json({ user, accessToken: token }); // Return user and the token
            }
            catch (error) {
                // If token verification fails, return empty user object
                return res.status(200).json({ user: null, accessToken: null });
            }
        }
        catch (error) {
            next(error);
        }
    }
    static async logout(req, res, next) {
        try {
            console.log('Logout requested');
            // Clear the cookie with the same settings used to set it
            res.clearCookie('access_token_w', {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                path: '/',
                domain: process.env.NODE_ENV === 'production' ? undefined : undefined
            });
            // Optionally clear refresh token cookie if used
            // res.clearCookie('refresh_token_w', { ...cookie options });
            // If user information is available in request
            if (req.user) {
                try {
                    await auth_service_1.AuthService.logout(req.user.id, req.user.type);
                    console.log(`User ${req.user.email} logged out successfully`);
                }
                catch (error) {
                    console.error('Error updating user logout status:', error);
                    // Continue with logout even if this fails
                }
            }
            console.log('Logout successful');
            res.status(200).json({ message: 'Logged out successfully' });
        }
        catch (error) {
            console.error('Logout error:', error);
            next(error);
        }
    }
    static async changePassword(req, res, next) {
        try {
            if (!req.user) {
                throw new errorHandler_1.AppError(401, 'Authentication required');
            }
            const { oldPassword, newPassword } = req.body;
            await auth_service_1.AuthService.changePassword(req.user.id, req.user.type, oldPassword, newPassword);
            res.json({ message: 'Password changed successfully' });
        }
        catch (error) {
            next(error);
        }
    }
    static async forgotPassword(req, res, next) {
        try {
            const { email, type = 'user' } = req.body;
            const token = await auth_service_1.AuthService.generatePasswordResetToken(email, type);
            // TODO: Send email with reset token
            res.json({ message: 'Password reset instructions sent to email' });
        }
        catch (error) {
            res.json({ message: 'If the email exists, reset instructions will be sent' });
        }
    }
    static async resetPassword(req, res, next) {
        try {
            const { token, newPassword } = req.body;
            await auth_service_1.AuthService.resetPassword(token, newPassword);
            res.json({ message: 'Password reset successfully' });
        }
        catch (error) {
            next(error);
        }
    }
    static async resendVerification(req, res, next) {
        try {
            if (!req.user) {
                throw new errorHandler_1.AppError(401, 'Authentication required');
            }
            const token = await auth_service_1.AuthService.generateEmailVerificationToken(req.user.id, req.user.type);
            // TODO: Send verification email
            res.json({ message: 'Verification email sent' });
        }
        catch (error) {
            next(error);
        }
    }
    static async checkEmail(req, res) {
        try {
            const { email } = req.body;
            const user = await user_service_1.UserService.findByEmail(email);
            const organization = (email === null || email === void 0 ? void 0 : email.includes('@')) ? await organization_service_1.OrganizationService.findByDomain(email.split('@')[1]) : null;
            return res.json({
                exists: !!user,
                hasPassword: (user === null || user === void 0 ? void 0 : user.password) ? true : false,
                organization: organization ? {
                    id: organization.id,
                    name: organization.name,
                    domain: organization.domain,
                } : null,
            });
        }
        catch (error) {
            console.error('Check email error:', error);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
    static async sendMagicLink(req, res) {
        try {
            const { email } = req.body;
            if (!email || !email.includes('@')) {
                throw new errorHandler_1.AppError(400, 'Invalid email address');
            }
            const domain = email.split('@')[1];
            const organization = await organization_service_1.OrganizationService.findByDomain(domain);
            if (!organization) {
                return res.status(403).json({ message: 'Email domain not associated with any organization' });
            }
            let user = await user_service_1.UserService.findByEmail(email);
            if (!user) {
                user = await user_service_1.UserService.createUser({
                    email,
                    password: '',
                    firstName: email.split('@')[0],
                    lastName: 'User',
                    role: 'member_full',
                });
            }
            const token = await auth_service_1.AuthService.generateMagicLinkToken(user.id);
            await user_service_1.UserService.updateUser(user.id, {
                magicLinkToken: token,
                magicLinkTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });
            console.log('Generated token:', token);
            console.log('CLIENT_URL:', process.env.CLIENT_URL);
            const magicLink = `${process.env.CLIENT_URL}/login?token=${token}`;
            console.log('Generated magic link:', magicLink);
            await email_service_1.EmailService.sendMagicLink(email, magicLink);
            return res.json({ message: 'Magic link sent successfully' });
        }
        catch (error) {
            console.error('Send magic link error:', error);
            if (error instanceof errorHandler_1.AppError) {
                return res.status(error.statusCode).json({ message: error.message });
            }
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
    static async verifyMagicLink(req, res) {
        try {
            const { token } = req.body;
            const userId = await auth_service_1.AuthService.verifyMagicLinkToken(token);
            if (!userId) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }
            const user = await user_service_1.UserService.findById(userId);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }
            const requiresTwoFactor = await auth_service_1.AuthService.isTwoFactorEnabled(user.id);
            const accessToken = await auth_service_1.AuthService.generateAccessToken(user);
            // Set cookie after successful magic link verification
            res.cookie('access_token_w', accessToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                maxAge: 24 * 60 * 60 * 1000,
                path: '/'
            });
            return res.json({
                user,
                accessToken, // Still return token for potential use, but cookie is primary
                requiresTwoFactor,
            });
        }
        catch (error) {
            console.error('Verify magic link error:', error);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
    static async setPassword(req, res) {
        try {
            const { token, password } = req.body;
            const userId = await auth_service_1.AuthService.verifyMagicLinkToken(token);
            if (!userId) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }
            const user = await user_service_1.UserService.findById(userId);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }
            await user_service_1.UserService.updateUser(userId, { password, isActive: true });
            const accessToken = await auth_service_1.AuthService.generateAccessToken(user);
            await auth_service_1.AuthService.clearMagicLinkToken(userId);
            // Set cookie after setting password
            res.cookie('access_token_w', accessToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                maxAge: 24 * 60 * 60 * 1000,
                path: '/'
            });
            return res.json({
                user,
                accessToken,
            });
        }
        catch (error) {
            console.error('Set password error:', error);
            if (error instanceof errorHandler_1.AppError) {
                return res.status(error.statusCode).json({ message: error.message });
            }
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
    static async register(req, res) {
        try {
            const { firstName, lastName, email, role, position } = req.body;
            const temporaryPassword = crypto_1.default.randomBytes(20).toString('hex');
            const user = await user_service_1.UserService.createUser({
                email,
                firstName,
                lastName,
                role,
                password: temporaryPassword,
                isActive: false,
                position,
            });
            const token = await auth_service_1.AuthService.generateMagicLinkToken(user.id);
            await user_service_1.UserService.updateUser(user.id, {
                magicLinkToken: token,
                magicLinkTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });
            const magicLinkUrl = `${process.env.CLIENT_URL}/create-password?token=${token}`;
            await email_service_1.EmailService.sendMagicLink(email, magicLinkUrl);
            res.status(201).json({
                message: 'User registered successfully. Magic link has been sent to the email.',
                userId: user.id,
            });
        }
        catch (error) {
            if (error instanceof errorHandler_1.AppError) {
                res.status(error.statusCode).json({ message: error.message });
            }
            else {
                console.error('Registration error:', error);
                res.status(500).json({ message: 'Failed to register user' });
            }
        }
    }
}
exports.AuthController = AuthController;
