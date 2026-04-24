'use strict';

const { IsString, IsNotEmpty, IsEnum, IsDateString, IsOptional, Length } = require('class-validator');
const { LeaveType } = require('../../../common/constants');

class CreateTimeOffRequestDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 128)
  employeeId = undefined;

  @IsString()
  @IsNotEmpty()
  @Length(1, 128)
  locationId = undefined;

  @IsEnum(LeaveType, {
    message: `leaveType must be one of: ${Object.values(LeaveType).join(', ')}`,
  })
  leaveType = undefined;

  // ISO date string: YYYY-MM-DD. Validated as date string, not DateTime.
  @IsDateString({}, { message: 'startDate must be a valid date (YYYY-MM-DD)' })
  startDate = undefined;

  @IsDateString({}, { message: 'endDate must be a valid date (YYYY-MM-DD)' })
  endDate = undefined;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes = undefined;
}

module.exports = { CreateTimeOffRequestDto };
