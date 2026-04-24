'use strict';

const { Controller, Get, Param, Post, HttpCode, HttpStatus, Inject } = require('@nestjs/common');
const { BalanceService } = require('./balance.service');

@Controller('balances')
class BalanceController {
  constructor(balanceService) {
    this.balanceService = balanceService;
  }

  /**
   * GET /balances/:employeeId/:locationId
   * Get all balances for an employee at a specific location
   */
  @Get(':employeeId/:locationId')
  async getBalancesForEmployee(
    employeeId,
    locationId,
  ) {
    return this.balanceService.getBalancesForEmployee(employeeId, locationId);
  }

  /**
   * GET /balances/:employeeId/:locationId/:leaveType
   * Get specific balance
   */
  @Get(':employeeId/:locationId/:leaveType')
  async getBalance(
    employeeId,
    locationId,
    leaveType,
  ) {
    return this.balanceService.getBalance(employeeId, locationId, leaveType);
  }

  /**
   * POST /balances/admin/seed
   * Admin endpoint to seed initial balances for testing purposes.
   * Note: In a real system, balances come from HCM batch sync.
   */
  @Post('admin/seed/:employeeId/:locationId/:leaveType/:total')
  @HttpCode(HttpStatus.CREATED)
  async seedBalance(
    employeeId,
    locationId,
    leaveType,
    total,
  ) {
    return this.balanceService.upsertBalance(employeeId, locationId, leaveType, parseFloat(total));
  }
}

Param('employeeId')(BalanceController.prototype, 'getBalancesForEmployee', 0);
Param('locationId')(BalanceController.prototype, 'getBalancesForEmployee', 1);

Param('employeeId')(BalanceController.prototype, 'getBalance', 0);
Param('locationId')(BalanceController.prototype, 'getBalance', 1);
Param('leaveType')(BalanceController.prototype, 'getBalance', 2);

Param('employeeId')(BalanceController.prototype, 'seedBalance', 0);
Param('locationId')(BalanceController.prototype, 'seedBalance', 1);
Param('leaveType')(BalanceController.prototype, 'seedBalance', 2);
Param('total')(BalanceController.prototype, 'seedBalance', 3);

Inject(BalanceService)(BalanceController, undefined, 0);

module.exports = { BalanceController };
