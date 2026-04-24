'use strict';

const {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Inject,
  UsePipes,
  ValidationPipe,
} = require('@nestjs/common');

const { TimeOffService } = require('./timeoff.service');
const { CreateTimeOffRequestDto } = require('./dto/create-timeoff-request.dto');
const { ApproveRequestDto, RejectRequestDto, CancelRequestDto } = require('./dto/update-request-status.dto');
const { RequestStatus } = require('../../common/constants');

@Controller('time-off/requests')
class TimeOffController {
  constructor(timeOffService) {
    this.timeOffService = timeOffService;
  }

  /**
   * POST /time-off/requests
   * Create a new time-off request.
   * Requires X-Idempotency-Key header.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  async createRequest(
    dto,
    idempotencyKey,
  ) {
    return this.timeOffService.createRequest(dto, idempotencyKey);
  }

  /**
   * GET /time-off/requests
   * List requests with optional filters.
   */
  @Get()
  async listRequests(
    employeeId,
    locationId,
    status,
    limit,
    offset,
  ) {
    // Validate status if provided
    if (status && !Object.values(RequestStatus).includes(status)) {
      const { UnprocessableEntityException } = require('@nestjs/common');
      throw new UnprocessableEntityException(`Invalid status: ${status}`);
    }
    return this.timeOffService.listRequests({ employeeId, locationId, status, limit, offset });
  }

  /**
   * GET /time-off/requests/:id
   */
  @Get(':id')
  async getRequest(id) {
    return this.timeOffService.getRequest(id);
  }

  /**
   * PATCH /time-off/requests/:id/approve
   */
  @Patch(':id/approve')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async approveRequest(
    id,
    dto,
  ) {
    return this.timeOffService.approveRequest(id, dto.approverId);
  }

  /**
   * PATCH /time-off/requests/:id/reject
   */
  @Patch(':id/reject')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async rejectRequest(
    id,
    dto,
  ) {
    return this.timeOffService.rejectRequest(id, dto.approverId, dto.reason);
  }

  /**
   * PATCH /time-off/requests/:id/cancel
   */
  @Patch(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async cancelRequest(
    id,
    dto,
  ) {
    return this.timeOffService.cancelRequest(id, dto.reason);
  }
}

Body()(TimeOffController.prototype, 'createRequest', 0);
Headers('x-idempotency-key')(TimeOffController.prototype, 'createRequest', 1);

Query('employeeId')(TimeOffController.prototype, 'listRequests', 0);
Query('locationId')(TimeOffController.prototype, 'listRequests', 1);
Query('status')(TimeOffController.prototype, 'listRequests', 2);
Query('limit')(TimeOffController.prototype, 'listRequests', 3);
Query('offset')(TimeOffController.prototype, 'listRequests', 4);

Param('id', ParseUUIDPipe)(TimeOffController.prototype, 'getRequest', 0);

Param('id', ParseUUIDPipe)(TimeOffController.prototype, 'approveRequest', 0);
Body()(TimeOffController.prototype, 'approveRequest', 1);

Param('id', ParseUUIDPipe)(TimeOffController.prototype, 'rejectRequest', 0);
Body()(TimeOffController.prototype, 'rejectRequest', 1);

Param('id', ParseUUIDPipe)(TimeOffController.prototype, 'cancelRequest', 0);
Body()(TimeOffController.prototype, 'cancelRequest', 1);

Inject(TimeOffService)(TimeOffController, undefined, 0);

module.exports = { TimeOffController };
