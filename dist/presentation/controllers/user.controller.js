"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserController = void 0;
const user_service_1 = require("../../services/user.service");
const errorHandler_1 = require("../middlewares/errorHandler");
const email_service_1 = require("../../services/email.service");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const group_service_1 = require("../../services/group.service");
class UserController {
    static async getUsers(req, res, next) {
        try {
            const { page = 1, limit = 10, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
            const result = await user_service_1.UserService.getUsers({
                page: Number(page),
                limit: Number(limit),
                search: search,
                sortBy: sortBy,
                sortOrder: sortOrder,
            });
            res.json(result);
        }
        catch (error) {
            next(error);
        }
    }
    static async getReviewers(req, res, next) {
        try {
            const result = await user_service_1.UserService.getReviewers({});
            res.json(result);
        }
        catch (error) {
            next(error);
        }
    }
    static async getApprovers(req, res, next) {
        try {
            const result = await user_service_1.UserService.getApprovers({});
            res.json(result);
        }
        catch (error) {
            next(error);
        }
    }
    static async getSuperUsers(req, res, next) {
        try {
            // Get the current user's ID from the authenticated request
            const authenticatedReq = req;
            const userId = authenticatedReq.user.id;
            const superUsers = await user_service_1.UserService.getSuperUsers(userId);
            res.json(superUsers);
        }
        catch (error) {
            next(error);
        }
    }
    static async getUser(req, res, next) {
        try {
            const { id } = req.params;
            const user = await user_service_1.UserService.getUser(id);
            res.json(user);
        }
        catch (error) {
            next(error);
        }
    }
    static async createUser(req, res, next) {
        try {
            const user = await user_service_1.UserService.createUser(req.body);
            res.status(201).json(user);
        }
        catch (error) {
            next(error);
        }
    }
    static async updateUser(req, res, next) {
        try {
            const { id } = req.params;
            console.log('Update user request body:', req.body);
            const user = await user_service_1.UserService.updateUser(id, req.body);
            res.json(user);
        }
        catch (error) {
            next(error);
        }
    }
    static async deleteUser(req, res, next) {
        try {
            const { id } = req.params;
            await user_service_1.UserService.deleteUser(id);
            res.status(204).send();
        }
        catch (error) {
            next(error);
        }
    }
    static async activateUser(req, res, next) {
        try {
            const { id } = req.params;
            const user = await user_service_1.UserService.updateUser(id, { isActive: true });
            res.json(user);
        }
        catch (error) {
            next(error);
        }
    }
    static async deactivateUser(req, res, next) {
        try {
            const { id } = req.params;
            const user = await user_service_1.UserService.updateUser(id, { isActive: false });
            res.json(user);
        }
        catch (error) {
            next(error);
        }
    }
    static async resendVerification(req, res, next) {
        try {
            const { id } = req.params;
            const token = await user_service_1.UserService.generateVerificationToken(id);
            const user = await user_service_1.UserService.getUser(id);
            await email_service_1.EmailService.sendVerificationEmail(user.email, token, 'user');
            res.json({ message: 'Verification email sent' });
        }
        catch (error) {
            next(error);
        }
    }
    static async getCurrentUser(req, res, next) {
        try {
            const userId = req.user.id;
            const user = await user_service_1.UserService.getUser(userId);
            res.json(user);
        }
        catch (error) {
            next(error);
        }
    }
    static async getUserWithRelatedData(req, res, next) {
        try {
            const userId = req.user.id;
            const includeParams = req.query.include ? req.query.include.split(',') : [];
            const result = await user_service_1.UserService.getUserWithRelatedData(userId, includeParams);
            res.json(result);
        }
        catch (error) {
            next(error);
        }
    }
    static async updateProfile(req, res, next) {
        try {
            const userId = req.user.id;
            const user = await user_service_1.UserService.updateUser(userId, req.body);
            res.json(user);
        }
        catch (error) {
            next(error);
        }
    }
    static async updatePassword(req, res, next) {
        try {
            const userId = req.user.id;
            const { currentPassword, newPassword } = req.body;
            const user = await user_service_1.UserService.getUser(userId);
            const isPasswordValid = await bcryptjs_1.default.compare(currentPassword, user.password);
            if (!isPasswordValid) {
                throw new errorHandler_1.AppError(400, 'Current password is incorrect');
            }
            await user_service_1.UserService.updateUser(userId, { password: newPassword });
            res.json({ message: 'Password updated successfully' });
        }
        catch (error) {
            next(error);
        }
    }
    static async getUserCabinets(req, res, next) {
        try {
            const userId = req.params.id;
            const cabinets = await user_service_1.UserService.getUserCabinets(userId);
            res.json(cabinets);
        }
        catch (error) {
            next(error);
        }
    }
    static async getUserGroups(req, res, next) {
        try {
            const userId = req.params.id;
            const groups = await group_service_1.GroupService.getGroupsByUserId(userId);
            res.json(groups);
        }
        catch (error) {
            next(error);
        }
    }
}
exports.UserController = UserController;
