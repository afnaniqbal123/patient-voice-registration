import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

const DOB_PATTERN = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(\d{4})$/;

/**
 * Validates MM/DD/YYYY strings, rejects calendar-invalid dates (e.g. 02/30/2020)
 * and rejects any date in the future — both required by the spec's DOB rules.
 */
export function IsValidDateOfBirth(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: 'isValidDateOfBirth',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          if (typeof value !== 'string' || !DOB_PATTERN.test(value)) return false;
          const [month, day, year] = value.split('/').map(Number);
          const date = new Date(year, month - 1, day);
          const isRealCalendarDate =
            date.getFullYear() === year &&
            date.getMonth() === month - 1 &&
            date.getDate() === day;
          if (!isRealCalendarDate) return false;
          return date.getTime() <= Date.now();
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid, non-future date in MM/DD/YYYY format`;
        },
      },
    });
  };
}
