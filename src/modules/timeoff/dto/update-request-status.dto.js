'use strict';

const { IsString, IsNotEmpty, IsOptional, Length } = require('class-validator');

class ApproveRequestDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 128)
  approverId = undefined;
}

class RejectRequestDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 128)
  approverId = undefined;

  @IsString()
  @IsNotEmpty()
  @Length(1, 500)
  reason = undefined;
}

class CancelRequestDto {
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason = undefined;
}

module.exports = { ApproveRequestDto, RejectRequestDto, CancelRequestDto };
