import { Brackets, NotBrackets, type WhereExpressionBuilder } from 'typeorm';

import { type GraphqlQueryFilterFieldParser } from 'src/engine/api/graphql/graphql-query-runner/graphql-query-parsers/graphql-query-filter/graphql-query-filter-field.parser';
import { type WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/query-builder/workspace-select-query-builder';

type FilterWalkContext = {
  outerQueryBuilder: WorkspaceSelectQueryBuilder;
  objectNameSingular: string;
  fieldParser: GraphqlQueryFilterFieldParser;
  useDirectTableReference: boolean;
  isNegated?: boolean;
};

// Inside a negation, a leaf comparison evaluating to NULL must count as "not
// matching" so that NOT keeps the row, mirroring in-memory record matching
const wrapWithNullSafeLeafConditions = (
  whereExpression: WhereExpressionBuilder,
): WhereExpressionBuilder =>
  new Proxy(whereExpression, {
    get(target, property, receiver) {
      if (
        property === 'where' ||
        property === 'andWhere' ||
        property === 'orWhere'
      ) {
        return (condition: unknown, parameters?: Record<string, unknown>) => {
          const nullSafeCondition =
            typeof condition === 'string'
              ? `COALESCE((${condition}), FALSE)`
              : condition;

          // oxlint-disable-next-line typescript/no-explicit-any
          (target as any)[property](nullSafeCondition, parameters);

          return receiver;
        };
      }

      return Reflect.get(target, property, receiver);
    },
  });

export const applyFilterEntriesToWhereExpression = ({
  whereExpression,
  outerQueryBuilder,
  objectNameSingular,
  filter,
  fieldParser,
  useDirectTableReference = false,
}: {
  whereExpression: WhereExpressionBuilder;
  outerQueryBuilder: WorkspaceSelectQueryBuilder;
  objectNameSingular: string;
  filter: Record<string, unknown>;
  fieldParser: GraphqlQueryFilterFieldParser;
  useDirectTableReference?: boolean;
}): void => {
  applyFilterEntries(whereExpression, filter, {
    outerQueryBuilder,
    objectNameSingular,
    fieldParser,
    useDirectTableReference,
  });
};

const applyFilterEntries = (
  whereExpression: WhereExpressionBuilder,
  filter: Record<string, unknown>,
  context: FilterWalkContext,
): void => {
  Object.entries(filter).forEach(([filterKey, filterValue], index) => {
    applyFilterEntry(
      whereExpression,
      filterKey,
      filterValue,
      index === 0,
      context,
    );
  });
};

const applyFilterEntry = (
  whereExpression: WhereExpressionBuilder,
  filterKey: string,
  // oxlint-disable-next-line typescript/no-explicit-any
  filterValue: any,
  isFirst: boolean,
  context: FilterWalkContext,
): void => {
  switch (filterKey) {
    case 'and':
      applyLogicalGroup(whereExpression, filterValue, 'and', isFirst, context);
      break;
    case 'or':
      applyLogicalGroup(whereExpression, filterValue, 'or', isFirst, context);
      break;
    case 'not':
      applyCondition(
        whereExpression,
        new NotBrackets((negatedWhereExpression) => {
          applyFilterEntries(negatedWhereExpression, filterValue, {
            ...context,
            isNegated: true,
          });
        }),
        isFirst,
      );
      break;
    default:
      context.fieldParser.parse(
        context.isNegated === true
          ? wrapWithNullSafeLeafConditions(whereExpression)
          : whereExpression,
        context.outerQueryBuilder,
        context.objectNameSingular,
        filterKey,
        filterValue,
        isFirst,
        context.useDirectTableReference,
      );
      break;
  }
};

const applyLogicalGroup = (
  whereExpression: WhereExpressionBuilder,
  filters: Record<string, unknown>[] | Record<string, unknown>,
  logicalOperator: 'and' | 'or',
  isFirst: boolean,
  context: FilterWalkContext,
): void => {
  const filterList = Array.isArray(filters) ? filters : [filters];

  const groupCondition = new Brackets((groupWhereExpression) => {
    filterList.forEach((filter, index) => {
      const elementCondition = new Brackets((elementWhereExpression) => {
        applyFilterEntries(elementWhereExpression, filter, context);
      });

      if (index === 0) {
        groupWhereExpression.where(elementCondition);
      } else if (logicalOperator === 'or') {
        groupWhereExpression.orWhere(elementCondition);
      } else {
        groupWhereExpression.andWhere(elementCondition);
      }
    });
  });

  applyCondition(whereExpression, groupCondition, isFirst);
};

const applyCondition = (
  whereExpression: WhereExpressionBuilder,
  condition: Brackets,
  isFirst: boolean,
): void => {
  if (isFirst) {
    whereExpression.where(condition);
  } else {
    whereExpression.andWhere(condition);
  }
};
