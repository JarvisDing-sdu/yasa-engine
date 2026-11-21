/** Experimental Clang AST adapter. Compiler-resolved structure is retained with coverage diagnostics. */
import * as fs from 'fs'
import * as UAST from '@ant-yasa/uast-spec'
import { mapOrigin, RawCoordinates } from './source-map'
import type { SourceSegment } from './source-map'
import { readCompilerDeclarations } from './compiler-declarations'
import { decodeClangString } from './clang-string'

type Ast = { kind?: string; id?: string; name?: string; inner?: Ast[]; [key: string]: any }
type Context = { scopes: string[]; languageLinkage: string; inFunction?: boolean; defaultStack?: string[] }
type DefaultValue = { node: Ast; context: Context }
export interface ClangUastOptions {
  sourcefile: string
  language: 'c' | 'cpp'
  languageVersion?: string
  raw: string
  sourceMap: SourceSegment[]
  validated?: boolean
  originalSourcefile?: string
  retainedRanges?: Array<{ begin: number; end: number }>
}

export class ClangUastConverter {
  private implicitArrayBudget = 4096
  private caseRangeBudget = 4096
  private readonly coordinates: RawCoordinates
  private readonly bytes: Buffer
  private readonly unsupported = new Map<string, number>()
  private readonly body: any[] = []
  private readonly recordFields = new Map<string, string[]>()
  private readonly recordMembers = new Map<string, Set<string>>()
  private readonly virtualMethods = new Map<string, Set<string>>()
  private readonly directBases = new Map<string, string>()
  private readonly singleConstructors = new Map<string, string>()
  private readonly trivialDefaults = new Set<string>()
  private readonly enumValues = new Map<string, string>()
  private readonly labels = new Map<string, string>()
  private readonly records = new Map<string, { ast: any; scopes: string[] }>()
  private readonly parameterDefaults = new Map<string, Array<DefaultValue | undefined>>()
  private readonly fieldDefaults = new Map<string, DefaultValue>()
  private readonly pendingDefaults: Array<{ arguments: any[]; index: number; key: string; context: Context; parameterIndex: number }> = []
  private readonly labelOffsets = new Map<string, number>()

  constructor(private readonly options: ClangUastOptions) {
    this.coordinates = new RawCoordinates(options.raw)
    this.bytes = Buffer.from(options.raw)
  }

  private offset(location: any): number | undefined {
    const value = location?.expansionLoc?.offset ?? location?.offset
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }

  private begins(node: Ast): number | undefined {
    return this.offset(node.range?.begin) ?? this.offset(node.loc)
  }

  includesDeclaration(node: Ast): boolean {
    const offset = this.begins(node)
    if (offset === undefined) return false
    const origin = mapOrigin(this.options.sourceMap, this.coordinates.location(offset).line)
    return !!origin && ((!origin.system && !origin.file.startsWith('<')) || origin.physicalFile === this.options.originalSourcefile || !!this.options.retainedRanges?.some(range => offset >= range.begin && offset < range.end))
  }

  private attach(value: any, node: Ast): any {
    const start = this.begins(node)
    const final = node.range?.end?.expansionLoc ?? node.range?.end
    const end = this.offset(final)
    if (start !== undefined) {
      const position = this.coordinates.location(start)
      value.loc = { sourcefile: this.options.sourcefile, start: position,
        end: this.coordinates.location(end === undefined ? start : end + (final?.tokLen || 0)) }
      const origin = mapOrigin(this.options.sourceMap, position.line)
      value._meta = { ...value._meta, clang: { kind: node.kind, id: node.id, type: node.type?.qualType, mangledName: node.mangledName }, originalColumnKnown: false }
      if (origin) value._meta.originalLocation = { sourcefile: origin.file, physicalFile: origin.physicalFile, start: { line: origin.line } }
    }
    return value
  }

  private text(node: Ast): string {
    const start = this.begins(node)
    const end = this.offset(node.range?.end)
    return start === undefined || end === undefined ? '' : this.bytes.subarray(start, end + (node.range?.end?.tokLen || 0)).toString('utf8')
  }

  private identifier(name: string, node: Ast, declarationId?: string): any {
    const located = node.loc ? { ...node, range: { begin: node.loc, end: node.loc } } : node
    const id: any = this.attach(UAST.identifier(name), located)
    if (declarationId) id._meta.clangDeclarationId = declarationId
    return id
  }

  private type(spelling = ''): any {
    const text = spelling.trim()
    let result: any
    const functionPointer = /^(.*?)\(\s*\*\s*\)\s*\((.*)\)$/.exec(text)
    const array = /^(.*?)((?:\[\d*\])+)$/.exec(text)
    const pointer = /^(.*?)\*\s*(?:(?:const|volatile|restrict)\s*)*$/.exec(text)
    if (functionPointer) {
      const parameters: string[] = []
      let start = 0, depth = 0
      const args = functionPointer[2]
      for (let index = 0; index <= args.length; index++) {
        const character = args[index]
        if ('(<['.includes(character || '\0')) depth++
        if (')>]'.includes(character || '\0')) depth--
        if (index === args.length || (character === ',' && depth === 0)) {
          const parameter = args.slice(start, index).trim()
          if (parameter && parameter !== 'void' && parameter !== '...') parameters.push(parameter)
          start = index + 1
        }
      }
      result = UAST.pointerType(UAST.identifier('pointer'), UAST.funcType(UAST.identifier('function'), [], parameters.map(parameter => this.type(parameter)), [this.type(functionPointer[1])]))
      result.kind = 'pointer'
    } else if (array) {
      result = this.type(array[1])
      const dimensions = [...array[2].matchAll(/\[(\d*)\]/g)].map(match => match[1])
      for (const dimension of dimensions.reverse()) result = UAST.arrayType(UAST.identifier('array'), result, null, dimension ? UAST.literal(Number(dimension), 'number') : null)
    } else if (pointer) {
      result = UAST.pointerType(UAST.identifier('pointer'), this.type(pointer[1]))
      result.kind = 'pointer'
    } else if (/&&?$/.test(text)) {
      result = this.type(text.replace(/&&?$/, ''))
      result._meta.clangReference = text.endsWith('&&') ? 'rvalue' : 'lvalue'
    } else if (text === 'void') result = UAST.voidType()
    else if (/^(?:const |volatile |restrict )*(?:unsigned |signed )?(?:char|short|int|long|float|double|bool|_Bool)(?:\s+long|\s+int|\s+double)?$/.test(text)) {
      const base = text.replace(/\b(?:const|volatile|restrict)\b/g, '').trim()
      result = UAST.primitiveType(UAST.identifier(base))
      result.kind = /bool|_Bool/.test(base) ? 'boolean' : /char/.test(base) ? 'string' : 'number'
    } else if (!text || text === 'auto' || text.includes('(lambda at ')) result = UAST.dynamicType()
    else result = UAST.scopedType(UAST.identifier(text.replace(/^(?:(?:const|volatile|restrict)\s+)*/, '').replace(/^(?:struct|class|union|enum)\s+/, '')), null)
    result._meta = { ...result._meta, clangType: text }
    return result
  }

  private flatten(nodes: any[]): any[] {
    return nodes.flatMap(node => !node ? [] : node.type === 'Sequence' && !node._meta?.gnuStatementExpression && !node._meta?.gnuAsm ? this.flatten(node.expressions) : [node])
  }

  private declarations(nodes: Ast[], context: Context): any[] {
    return this.flatten(nodes.filter(node => !node.isImplicit && this.includesDeclaration(node)).map(node => this.visit(node, context)))
  }

  private expression(node: Ast | undefined, context: Context): any {
    const result = node ? this.visit(node, context) : null
    if (result && UAST.isExpression(result)) return result
    if (node && result?.type !== 'Noop') {
      const kind = 'expression_lowering_' + node.kind
      this.unsupported.set(kind, (this.unsupported.get(kind) || 0) + 1)
    }
    return this.attach(UAST.noop(), node || {})
  }

  private statement(node: Ast | undefined, context: Context): any {
    const result = node ? this.visit(node, context) : UAST.noop()
    if (!result) return UAST.noop()
    return UAST.isExpression(result) && !UAST.isStatement(result) ? this.attach(UAST.expressionStatement(result), node!) : result
  }

  private variable(node: Ast, context: Context): any {
    const values = (node.inner || []).filter(child => !child.kind?.endsWith('Attr'))
    const initializer = node.isBitfield && !node.hasInClassInitializer ? undefined : values.at(-1)
    if (node.isBitfield && !node.name) {
      const padding: any = this.attach(UAST.noop(), node)
      padding._meta.bitfield = { unnamed: true, width: this.expression(values[0], context), type: this.type(node.type?.qualType) }
      return padding
    }
    const decl = UAST.variableDeclaration(this.identifier(node.name || '_', node, node.id),
      initializer ? this.expression(initializer, context) : null, false, this.type(node.type?.desugaredQualType || node.type?.qualType))
    const result: any = this.attach(decl, node)
    if (node.kind === 'ParmVarDecl') result._meta.isParameter = true
    if (/&&?$/.test(node.type?.qualType || '')) result._meta.reference = node.type.qualType.endsWith('&&') ? 'rvalue' : 'lvalue'
    if (node.storageClass) result._meta.storage = [node.storageClass]
    if (node.isBitfield) result._meta.bitfield = { width: this.expression(values[0], context) }
    if (context.scopes.length && !context.inFunction && node.kind === 'VarDecl') {
      result._meta.namespace = context.scopes.join('::')
      result._meta.qualifiedName = [...context.scopes, node.name].join('::')
    }
    return result
  }

  private lowerSimpleBackedges(body: Ast): Ast {
    if (this.options.language !== 'c' || body.kind !== 'CompoundStmt') return body
    const top = [...(body.inner || [])]
    const nodes = (roots: Ast[]): Ast[] => {
      const pending = [...roots], result: Ast[] = []
      while (pending.length) { const node = pending.pop()!; result.push(node); pending.push(...(node.inner || [])) }
      return result
    }
    const all = nodes([body])
    for (let index = 0; index < top.length; index++) {
      const label = top[index]
      if (label.kind !== 'LabelStmt' || !label.declId || !label.inner?.[0]) continue
      if (all.filter(node => node.kind === 'GotoStmt' && node.targetLabelDeclId === label.declId).length !== 1) continue
      for (let end = index + 1; end < top.length; end++) {
        const branch = top[end], parts = branch.inner || []
        const jump = parts[1]?.kind === 'CompoundStmt' && parts[1].inner?.length === 1 ? parts[1].inner[0] : parts[1]
        if (branch.kind !== 'IfStmt' || branch.hasElse || parts.length !== 2 || jump?.kind !== 'GotoStmt' || jump.targetLabelDeclId !== label.declId) continue
        const statements = [label.inner[0], ...top.slice(index + 1, end)]
        if (nodes([...statements, parts[0]]).some(node => ['VarDecl', 'LabelStmt', 'GotoStmt', 'IndirectGotoStmt', 'AddrLabelExpr', 'BreakStmt', 'ContinueStmt', 'CaseStmt', 'DefaultStmt'].includes(node.kind || ''))) continue
        // With one backedge, no other entry and no scope/control transfers,
        // this region is exactly a post-test loop. General goto remains partial.
        if (all.some(node => node.kind === 'AddrLabelExpr' || node.kind === 'IndirectGotoStmt')) continue
        const range = { begin: label.range?.begin, end: branch.range?.end }
        top.splice(index, end - index + 1, { kind: 'DoStmt', range, yasaBackedge: label.name,
          inner: [{ kind: 'CompoundStmt', range, inner: statements }, parts[0]] })
        break
      }
    }
    return { ...body, inner: top }
  }

  private function(node: Ast, context: Context): any {
    const children = node.inner || []
    const previous = this.parameterDefaults.get(node.previousDecl)
    const defaults = children.filter(child => child.kind === 'ParmVarDecl').map((parameter, index) => {
      const value = parameter.inner?.filter(child => !child.kind?.endsWith('Attr')).at(-1)
      return value ? { node: value, context } : previous?.[index]
    })
    if (node.id) this.parameterDefaults.set(node.id, defaults)
    if (node.kind === 'CXXConstructorDecl') this.parameterDefaults.set(context.scopes.join('::') + '|' + node.type?.qualType, defaults)
    const body = children.find(child => child.kind === 'CompoundStmt' || child.kind === 'CXXTryStmt')
    if (!body) {
      const prototype: any = this.attach(UAST.noop(), node)
      prototype._meta.prototype = node.name
      return prototype
    }
    const pending = [body]
    while (pending.length) {
      const statement = pending.pop()!
      if (statement.kind === 'LabelStmt' && statement.declId) {
        this.labels.set(statement.declId, statement.name || '_')
        const offset = this.begins(statement)
        if (offset !== undefined) this.labelOffsets.set(statement.declId, offset)
      }
      pending.push(...(statement.inner || []))
    }
    const functionType = node.type?.qualType || ''
    const trailingReturn = functionType.lastIndexOf(' -> ')
    const returnType = node.kind === 'CXXConstructorDecl' || node.kind === 'CXXDestructorDecl'
      ? 'void' : trailingReturn >= 0 ? functionType.slice(trailingReturn + 4) : functionType.split(' (')[0]
    let functionBody = this.statement(this.lowerSimpleBackedges(body), { ...context, inFunction: true })
    const initializers = children.filter(child => child.kind === 'CXXCtorInitializer')
    if (initializers.length) {
      const statements = initializers.map(initializer => {
        const input = initializer.inner?.[0]
        const fieldDefault = input?.kind === 'CXXDefaultInitExpr' ? this.fieldDefaults.get(initializer.anyInit?.id) : undefined
        const value = fieldDefault ? this.expression(fieldDefault.node, { ...fieldDefault.context, inFunction: true })
          : this.expression(input, { ...context, inFunction: true })
        if (initializer.anyInit?.name) {
          return this.attach(UAST.expressionStatement(UAST.assignmentExpression(
            UAST.memberAccess(UAST.thisExpression(), this.identifier(initializer.anyInit.name, initializer), false), value, '=', false,
          )), initializer.inner?.[0] || node)
        }
        const owner = context.scopes.join('::')
        const base = this.directBases.get(owner)
        if (initializer.baseInit && base && input?.kind === 'CXXConstructExpr' &&
            input.constructionKind === 'non-virtual base' && value.type === 'NewExpression') {
          const signature = input.ctorType?.qualType
          // Value initialization may zero fields even when the default ctor is trivial.
          if (this.trivialDefaults.has(base) && !input.zeroing && !value.arguments.length && signature?.startsWith('void ()')) {
            const noop = this.attach(UAST.noop(), input)
            noop._meta.clangTrivialBaseConstructor = base
            return noop
          }
          if (!input.zeroing && signature && this.singleConstructors.get(base) === signature) {
            const member = UAST.memberAccess(UAST.superExpression(), UAST.identifier('_CTOR_'), false)
            member._meta.clangBaseConstructor = base
            const call = this.attach(UAST.callExpression(member, value.arguments), input)
            return this.attach(UAST.expressionStatement(call), input)
          }
        }
        this.unsupported.set('base_or_delegating_constructor', (this.unsupported.get('base_or_delegating_constructor') || 0) + 1)
        return this.attach(UAST.expressionStatement(value), initializer.inner?.[0] || node)
      })
      functionBody = this.attach(UAST.scopedStatement([...statements, functionBody]), body)
    }
    const result: any = this.attach(UAST.functionDefinition(
      node.name ? this.identifier(node.name, node, node.id) : null,
      children.filter(child => child.kind === 'ParmVarDecl').map(child => this.variable(child, context)),
      this.type(returnType), functionBody, node.storageClass ? [node.storageClass] : [],
    ), node)
    if (context.scopes.length) {
      result._meta.namespace = context.scopes.join('::')
      result._meta.qualifiedName = [...context.scopes, node.name].join('::')
    }
    result._meta.languageLinkage = context.languageLinkage
    if (node.kind === 'CXXConstructorDecl') result._meta.isConstructor = true
    if (node.kind === 'CXXDestructorDecl') result._meta.isDestructor = true
    if (node.virtual) this.unsupported.set('cpp_virtual_dispatch', (this.unsupported.get('cpp_virtual_dispatch') || 0) + 1)
    return result
  }

  private functionDeclaration(node: Ast, context: Context): any {
    const owner = this.records.get(node.parentDeclContextId)
    if (!owner) return this.function(node, context)
    const definition = this.function(node, { ...context, scopes: owner.scopes })
    owner.ast.body.push(definition)
    const attached: any = this.attach(UAST.noop(), node)
    attached._meta.clangOutOfLineDefinition = { owner: owner.scopes.join('::'), declarationId: node.id }
    return attached
  }

  private record(node: Ast, context: Context): any {
    if (!node.completeDefinition) return this.attach(UAST.noop(), node)
    const arguments_ = (node.inner || []).filter(child => child.kind === 'TemplateArgument').map(child => child.type?.qualType ?? child.value ?? '?')
    const name = (node.name || 'anonymous_record') + (arguments_.length ? '<' + arguments_.join(',') + '>' : '')
    const fields = (node.inner || []).filter(child => child.kind === 'FieldDecl' && child.name).map(child => child.name!)
    this.recordFields.set([...context.scopes, name].join('::'), fields)
    this.recordFields.set(name, fields)
    const scopes = [...context.scopes, name]
    for (const field of (node.inner || []).filter(child => child.kind === 'FieldDecl' && child.hasInClassInitializer)) {
      const initializer = field.inner?.filter(child => !child.kind?.endsWith('Attr')).at(-1)
      if (field.id && initializer) this.fieldDefaults.set(field.id, { node: initializer, context: { ...context, scopes } })
    }
    const result: any = this.attach(UAST.classDefinition(this.identifier(name, node, node.id), [], []), node)
    const owner = { ast: result, scopes }
    if (node.id) this.records.set(node.id, owner)
    if (node.previousDecl) this.records.set(node.previousDecl, owner)

    result._meta.kind = node.tagUsed || 'class'
    result._meta.qualifiedName = [...context.scopes, name].join('::')
    const declaredMembers = (node.inner || []).filter(child => !child.isImplicit &&
      ['FieldDecl', 'CXXMethodDecl'].includes(child.kind || '') && child.name)
    if (node.bases?.length) {
      result._meta.clangBases = node.bases.map((base: any) => ({ type: base.type?.qualType, access: base.access, isVirtual: base.isVirtual }))
      const base = node.bases[0]
      const baseType = (base.type?.desugaredQualType || base.type?.qualType || '').replace(/^(?:struct|class)\s+/, '')
      const candidates = [...context.scopes.map((_, i) => context.scopes.slice(0, context.scopes.length - i).join('::') + '::' + baseType), baseType]
      const known = candidates.find(name => this.recordMembers.has(name))
      const hidesMember = known && declaredMembers.some(child => child.name && this.recordMembers.get(known)!.has(child.name) &&
        !(child.kind === 'CXXMethodDecl' && this.virtualMethods.get(known)?.has(child.name + '|' + child.type?.qualType)))
      if (node.bases.length === 1 && !base.isVirtual && known && !hidesMember && !context.inFunction) {
        this.directBases.set(scopes.join('::'), known)
        result.supers = [this.identifier(known, node)]
        result._meta.clangInheritance = 'single_nonvirtual'
      } else this.unsupported.set('cpp_baseclass_semantics', (this.unsupported.get('cpp_baseclass_semantics') || 0) + 1)
    }
    if (!context.inFunction && (!node.bases?.length || result._meta.clangInheritance)) {
      const members = new Set<string>(declaredMembers.map(child => child.name!))
      for (const base of result.supers) for (const member of this.recordMembers.get(base.name) || []) members.add(member)
      const virtuals = new Set<string>(this.virtualMethods.get(this.directBases.get(scopes.join('::')) || ''))
      for (const child of node.inner || []) {
        if (child.kind === 'CXXMethodDecl' && child.virtual) virtuals.add(child.name + '|' + child.type?.qualType)
      }
      this.virtualMethods.set(scopes.join('::'), virtuals)
      const constructors = (node.inner || []).filter(child => child.kind === 'CXXConstructorDecl' && !child.isImplicit)
      if (constructors.length === 1 && !constructors[0].explicitlyDefaulted && constructors[0].type?.qualType) {
        this.singleConstructors.set(scopes.join('::'), constructors[0].type.qualType)
      }
      if (node.definitionData?.defaultCtor?.trivial) this.trivialDefaults.add(scopes.join('::'))
      this.recordMembers.set(scopes.join('::'), members)
    }
    result.body.push(...this.declarations(node.inner || [], { ...context, scopes }))
    return result
  }

  private enumConstant(node: Ast | undefined): bigint | undefined {
    if (!node) return undefined
    if (node.value !== undefined) {
      if (node.value === true || node.value === 'true') return 1n
      if (node.value === false || node.value === 'false') return 0n
      return /^-?\d+$/.test(String(node.value)) ? BigInt(node.value) : undefined
    }
    if (['ConstantExpr', 'ParenExpr'].includes(node.kind || '') && node.inner?.length === 1) return this.enumConstant(node.inner[0])
    if (node.kind === 'UnaryOperator' && ['+', '-'].includes(node.opcode) && node.inner?.length === 1 &&
        /^(?:int|long|long long)$/.test(node.type?.qualType || '') && node.inner[0].kind === 'IntegerLiteral') {
      const value = this.enumConstant(node.inner[0])
      if (value !== undefined) return node.opcode === '-' ? -value : value
    }
    if (node.kind !== 'ImplicitCastExpr' || node.inner?.length !== 1) return undefined
    const value = this.enumConstant(node.inner[0])
    if (value === undefined) return undefined
    if (node.castKind === 'IntegralToBoolean') return value === 0n ? 0n : 1n
    if (node.castKind !== 'IntegralCast') return undefined
    const type = node.type?.desugaredQualType || node.type?.qualType || ''
    const sourceType = node.inner[0].type?.desugaredQualType || node.inner[0].type?.qualType || ''
    const ranks: Record<string, number> = { 'signed char': 1, 'unsigned char': 1, short: 2, 'unsigned short': 2,
      int: 3, 'unsigned int': 3, long: 4, 'unsigned long': 4, 'long long': 5, 'unsigned long long': 5 }
    // A compiler-folded signed source value fits the corresponding unsigned
    // type when nonnegative; same-signedness non-narrowing conversions also
    // preserve it. This avoids assuming that the compilation target has 32-bit int.
    const sourceRank = ranks[sourceType], targetRank = ranks[type]
    if (sourceRank && targetRank >= sourceRank &&
        (type.startsWith('unsigned ') ? value >= 0n : !sourceType.startsWith('unsigned '))) return value
    // Only unwrap value-preserving casts within the target's guaranteed range.
    // Larger or implementation-dependent conversions retain a coverage diagnostic.
    const widths: Record<string, number> = { 'signed char': 8, 'unsigned char': 8, short: 16, 'unsigned short': 16,
      int: 16, 'unsigned int': 16, long: 32, 'unsigned long': 32, 'long long': 64, 'unsigned long long': 64 }
    const width = widths[type]
    if (!width) return undefined
    const unsigned = type.startsWith('unsigned ')
    const limit = 1n << BigInt(width - (unsigned ? 0 : 1))
    return value >= (unsigned ? 0n : -limit) && value < limit ? value : undefined
  }

  private enumeration(node: Ast, context: Context): any {
    let next: bigint | undefined = 0n
    const declarations = (node.inner || []).filter(child => child.kind === 'EnumConstantDecl').map(child => {
      const expression = child.inner?.[0]
      const value = expression ? this.enumConstant(expression) : next
      next = value === undefined ? undefined : value + 1n
      if (child.id && value !== undefined) this.enumValues.set(child.id, value.toString())
      const numeric = Number(value)
      let literal: any
      if (value === undefined) {
        literal = expression ? this.expression(expression, context) : this.attach(UAST.noop(), child)
        // Preserve the unresolved initializer/expression instead of discarding the
        // enum declaration. Consumers can distinguish a compiler-folded value from
        // one whose value is only available after template instantiation.
        literal._meta = { ...literal._meta, dependentEnumValue: true }
      } else literal = this.attach(UAST.literal(Number.isSafeInteger(numeric) ? numeric : value.toString(), 'number'), child)
      return this.attach(UAST.variableDeclaration(this.identifier(child.name || '_', child, child.id), literal, false, this.type(child.type?.qualType)), child)
    })
    const result: any = this.attach(UAST.classDefinition(this.identifier(node.name || 'anonymous_enum', node, node.id), declarations, []), node)
    result._meta.kind = 'enum'
    return result
  }

  private initializer(node: Ast, context: Context): any {
    const spelling = node.type?.desugaredQualType || node.type?.qualType || ''
    const array = /\[(\d+)\]/.exec(spelling)
    const fields = node.field?.name ? [node.field.name] : this.recordFields.get(spelling.replace(/^(?:(?:const|volatile|restrict)\s+)*/, '').replace(/^(?:struct|class|union)\s+/, ''))
    const values = node.array_filler ? node.array_filler.slice(1) : node.inner || []
    const properties = values.map((child: Ast, index: number) => UAST.objectProperty(
      fields?.[index] ? this.identifier(fields[index], child) : UAST.literal(index, 'number'), this.expression(child, context),
    ))
    const result: any = this.attach(UAST.objectExpression(properties), node)
    result._meta.initializerList = true
    if (array) result._meta.isArray = true
    if (node.array_filler?.[0]) {
      result._meta.clangArrayDefault = this.expression(node.array_filler[0], context)
      if (array && values.length < Number(array[1])) {
        const missing = Number(array[1]) - values.length
        const element = String(node.array_filler[0].type?.desugaredQualType || node.array_filler[0].type?.qualType || '').replace(/\[\d+\]/g, '').trim()
        const scalar = /\*/.test(element) || /^(?:(?:const|volatile|restrict|signed|unsigned)\s+)*(?:char|short|int|long|long long|long double|float|double|bool|_Bool)(?: int)?$/.test(element)
        if (scalar && missing <= this.implicitArrayBudget) {
          this.implicitArrayBudget -= missing
          for (let index = values.length; index < Number(array[1]); index++) {
            properties.push(UAST.objectProperty(UAST.literal(index, 'number'), this.expression(node.array_filler[0], context)))
          }
          result._meta.clangArrayFilled = missing
        } else {
          result._meta.clangImplicitArrayTail = {
            count: missing,
            elementType: element,
            defaultValue: this.expression(node.array_filler[0], context),
            expanded: false,
          }
        }
      }
    }
    return result
  }

  private switch(node: Ast, context: Context): any {
    const children = [...(node.inner || [])]
    const body = children.pop()
    const condition = children.pop()
    const clauses: any[] = []
    let current: any
    const prefix: Ast[] = []
    for (const statement of body?.inner || []) {
      if (statement.kind === 'CaseStmt' || statement.kind === 'DefaultStmt') break
      prefix.push(statement)
    }
    const hoist = this.options.language === 'c' && prefix.length > 0 && prefix.every(statement => statement.kind === 'DeclStmt' &&
      statement.inner?.every(decl => decl.kind === 'VarDecl' && !decl.init &&
        !(decl.inner || []).some(child => !child.kind?.endsWith('Attr'))))
    const declarations: any[] = []
    const append = (statement: Ast): void => {
      // An ordinary label may wrap a case/default label. It does not make
      // that case or its following statements a pre-switch unreachable prefix.
      const labels: Ast[] = []
      let labelled = statement
      while (labelled.kind === 'LabelStmt' && labelled.inner?.[0]) {
        labels.push(labelled)
        labelled = labelled.inner[0]
      }
      if (labels.length && (labelled.kind === 'CaseStmt' || labelled.kind === 'DefaultStmt')) {
        const first = clauses.length
        append(labelled)
        if (clauses[first]) {
          let marker: any = this.attach(UAST.noop(), labels.at(-1)!)
          for (const label of [...labels].reverse()) {
            marker = this.attach(UAST.labeledStatement(this.identifier(label.name || '_', label), marker), label)
          }
          clauses[first].body.body.unshift(marker)
        }
        return
      }
      if (statement.kind === 'CaseStmt' || statement.kind === 'DefaultStmt') {
        const parts = statement.inner || []
        current = this.attach(UAST.caseClause(statement.kind === 'CaseStmt' ? this.expression(parts[0], context) : null, UAST.scopedStatement([])), statement)
        if (statement.isGNURange) {
          const low = this.enumConstant(parts[0]), high = this.enumConstant(parts[1])
          if (low !== undefined && high !== undefined && high >= low && high - low < 256n && Number(high - low + 1n) <= this.caseRangeBudget) {
            this.caseRangeBudget -= Number(high - low + 1n)
            for (let value = low; value <= high; value++) {
              const numeric = Number(value)
              current = this.attach(UAST.caseClause(this.attach(UAST.literal(Number.isSafeInteger(numeric) ? numeric : value.toString(), 'number'), parts[0]), UAST.scopedStatement([])), statement)
              current._meta.clangCaseRange = { low: low.toString(), high: high.toString(), expanded: true }
              clauses.push(current)
            }
          } else {
            current._meta.clangCaseRange = { upper: this.expression(parts[1], context), expanded: false }
            this.unsupported.set('case_range_control_flow', (this.unsupported.get('case_range_control_flow') || 0) + 1)
            clauses.push(current)
          }
          if (parts[2]) append(parts[2])
          return
        }
        clauses.push(current)
        const next = statement.kind === 'CaseStmt' ? parts[1] : parts[0]
        if (next) append(next)
      } else if (current) current.body.body.push(this.statement(statement, context))
      else if (hoist) declarations.push(...this.flatten([this.visit(statement, context)]))
      else this.unsupported.set('switch_pre_label_statement', (this.unsupported.get('switch_pre_label_statement') || 0) + 1)
    }
    for (const statement of body?.inner || []) append(statement)
    const result = this.attach(UAST.switchStatement(this.expression(condition, context), clauses), node)
    if (hoist) {
      let name = '__yasa_switch_value_' + (this.begins(node) ?? 0)
      while (this.options.raw.includes(name)) name += '_'
      const temporary = this.identifier(name, condition!)
      const saved = this.attach(UAST.variableDeclaration(temporary, result.discriminant, false, this.type(condition?.type?.qualType)), condition!)
      result.discriminant = this.identifier(name, condition!)
      result._meta.clangSwitchDeclarations = true
      return this.attach(UAST.scopedStatement([...children.map(child => this.statement(child, context)), saved, ...declarations, result]), node)
    }
    return children.length ? this.attach(UAST.scopedStatement([...children.map(child => this.statement(child, context)), result]), node) : result
  }

  private range(node: Ast, context: Context): any {
    const children = node.inner || []
    const range = children[1]?.inner?.find(child => child.kind === 'VarDecl')
    const binding = children[6]?.inner?.find(child => child.kind === 'VarDecl')
    if (children.length !== 8 || !range || !binding) return this.unsupportedNode(node)
    const variable = this.variable({ ...binding, inner: [] }, context)
    variable.init = null
    const result = this.attach(UAST.rangeStatement(null, variable, this.expression(range.inner?.at(-1), context), this.statement(children[7], context)), node)
    return children[0]?.kind ? this.attach(UAST.scopedStatement([this.statement(children[0], context), result]), node) : result
  }

  private dependentIdentifier(node: Ast): any {
    const text = this.text(node)
    const name = node.name || text.split('::').at(-1)?.replace(/<.*$/, '') || '_'
    const id = this.identifier(name, node)
    const qualifier = text.slice(0, text.lastIndexOf('::'))
    if (text.includes('::')) id._meta.qualifier = qualifier
    id._meta.clangDependent = true
    if (node.lookups) id._meta.clangCandidates = node.lookups.map((candidate: any) => ({ id: candidate.id, name: candidate.name, kind: candidate.kind }))
    this.unsupported.set('dependent_name_resolution', (this.unsupported.get('dependent_name_resolution') || 0) + 1)
    return id
  }

  private lambda(node: Ast, context: Context): any {
    const record = (node.inner || []).find(child => child.kind === 'CXXRecordDecl')
    const template = record?.inner?.find(child => child.kind === 'FunctionTemplateDecl' && child.name === 'operator()')
    const method = record?.inner?.find(child => child.kind === 'CXXMethodDecl' && child.name === 'operator()')
      || template?.inner?.find(child => child.kind === 'CXXMethodDecl')
    if (!method) return this.unsupportedNode(node)
    const result = this.function(method, context)
    result.id = null
    result._meta.cppLambda = { generic: !!template, captureSemantics: 'recorded_only', spelling: this.text(node).split('{')[0] }
    if (template) this.unsupported.set('generic_lambda_instantiation', (this.unsupported.get('generic_lambda_instantiation') || 0) + 1)
    const captures = (node.inner || []).filter(child => !['CXXRecordDecl', 'CompoundStmt'].includes(child.kind || ''))
    if (captures.length) {
      result._meta.clangCaptureInitializers = captures.map(child => this.expression(child, context))
      const fields = record?.inner?.filter(child => child.kind === 'FieldDecl') || []
      const simpleReferences = /^\[\s*(?:&|&\s*\w+(?:\s*,\s*&\s*\w+)*)\s*\]/.test(this.text(node)) &&
        fields.length === captures.length && fields.every(field => /&$/.test(field.type?.qualType || '')) &&
        captures.every(capture => capture.kind === 'DeclRefExpr')
      const scalar = (spelling: string) => /^(?:(?:const|volatile|signed|unsigned)\s+)*(?:char|short|int|long|long long|long double|float|double|bool)(?: int)?$/.test(spelling)
      const references = captures.map(capture => {
        let value = capture
        while (value.kind === 'ImplicitCastExpr' && value.inner?.length === 1) value = value.inner[0]
        return value.kind === 'DeclRefExpr' ? value.referencedDecl : undefined
      })
      const simpleValues = /^\[\s*(?:=|[a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)*)\s*\]/.test(this.text(node)) &&
        fields.length === captures.length && fields.every(field => scalar(field.type?.desugaredQualType || field.type?.qualType || '')) &&
        references.every(reference => reference?.name && reference.name !== 'this')
      if (simpleReferences) result._meta.cppLambda.captureSemantics = 'lexical_reference'
      else if (simpleValues) {
        result._meta.cppLambda.captureSemantics = 'scalar_snapshot'
        result._meta.cppLambda.captures = references.map((reference, index) => ({ name: reference!.name,
          value: result._meta.clangCaptureInitializers[index] }))
      } else this.unsupported.set('lambda_capture_semantics', (this.unsupported.get('lambda_capture_semantics') || 0) + 1)
    }
    return this.attach(result, node)
  }

  private unsupportedNode(node: Ast): any {
    const kind = node.kind || 'unknown'
    this.unsupported.set(kind, (this.unsupported.get(kind) || 0) + 1)
    const result: any = this.attach(UAST.noop(), node)
    result._meta = { ...result._meta, unhandled: { kind: 'Clang.' + kind } }
    return result
  }

  private calleeReference(node: Ast | undefined): { id?: string; kind?: string } {
    if (!node) return {}
    if (node.referencedDecl) return node.referencedDecl
    if (node.referencedMemberDecl) return { id: node.referencedMemberDecl, kind: 'CXXMethodDecl' }
    return this.calleeReference(node.inner?.[0])
  }

  private arguments(nodes: Ast[], context: Context, key: string, parameterOffset = 0): any[] {
    const arguments_: any[] = []
    for (const [index, node] of nodes.entries()) {
      if (node.kind === 'CXXDefaultArgExpr' && !node.inner?.length) {
        arguments_.push(this.attach(UAST.noop(), node))
        this.pendingDefaults.push({ arguments: arguments_, index, key, context, parameterIndex: index + parameterOffset })
      } else arguments_.push(this.expression(node, context))
    }
    return arguments_
  }

  visit(node: Ast, context: Context = { scopes: [], languageLinkage: this.options.language === 'c' ? 'C' : 'C++' }): any {
    const children = node.inner || []
    if (node.kind?.endsWith('Attr')) {
      const attribute: any = this.attach(UAST.noop(), node)
      attribute._meta.clangAttribute = node.kind
      return attribute
    }
    switch (node.kind) {
      case 'NamespaceDecl': return this.attach(UAST.sequence(this.declarations(children, { ...context, scopes: [...context.scopes, node.name || 'anonymous_namespace'] })), node)
      case 'LinkageSpecDecl': return this.attach(UAST.sequence(this.declarations(children, { ...context, languageLinkage: node.language || context.languageLinkage })), node)
      case 'ClassTemplateDecl':
      case 'FunctionTemplateDecl': {
        const definitions = this.declarations(children.filter(child => ['CXXRecordDecl', 'ClassTemplateSpecializationDecl', 'FunctionDecl', 'CXXMethodDecl', 'CXXConstructorDecl', 'CXXConversionDecl'].includes(child.kind || '')), context)
        for (const definition of definitions) definition._meta.clangTemplate = { name: node.name, kind: node.kind }
        return this.attach(UAST.sequence(definitions), node)
      }
      case 'CXXRecordDecl':
      case 'RecordDecl':
      case 'ClassTemplateSpecializationDecl':
      case 'ClassTemplatePartialSpecializationDecl': return this.record(node, context)
      case 'FunctionDecl':
      case 'CXXMethodDecl':
      case 'CXXConstructorDecl':
      case 'CXXDestructorDecl':
      case 'CXXConversionDecl': return this.functionDeclaration(node, context)
      case 'EnumDecl': return this.enumeration(node, context)
      case 'GenericSelectionExpr': {
        const selected = children.find(child => child.selected)
        return selected?.inner?.length ? this.expression(selected.inner.at(-1), context) : this.unsupportedNode(node)
      }
      case 'InitListExpr': return this.initializer(node, context)
      case 'CXXDefaultArgExpr': return children[0] ? this.expression(children[0], context) : this.unsupportedNode(node)
      case 'CXXStdInitializerListExpr': {
        const result: any = this.attach(UAST.castExpression(this.expression(children[0], context), this.type(node.type?.qualType)), node)
        result._meta.clangStdInitializerList = true
        this.unsupported.set('initializer_list_object_semantics', (this.unsupported.get('initializer_list_object_semantics') || 0) + 1)
        return result
      }
      case 'ParenListExpr': {
        const result: any = this.attach(UAST.tupleExpression(children.map(child => this.expression(child, context))), node)
        result._meta.clangParenthesizedInitializer = true
        this.unsupported.set('dependent_parenthesized_initialization', (this.unsupported.get('dependent_parenthesized_initialization') || 0) + 1)
        return result
      }

      case 'TypeTraitExpr': {
        if (this.options.language !== 'c' || !this.text(node).startsWith('__builtin_types_compatible_p')) return this.unsupportedNode(node)
        const result: any = this.attach(UAST.callExpression(this.identifier('__builtin_types_compatible_p', node), []), node)
        result._meta.typeArguments = children.map(child => this.type(child.type?.desugaredQualType || child.type?.qualType))
        return result
      }
      case 'AtomicExpr': {
        // Clang groups atomic operands by semantic role, not by source argument order.
        // This adapter consumes preprocessed text; distinct operand ranges recover the
        // original argument positions without imposing a runtime evaluation order.
        const operands = children.map(child => ({ child, offset: this.begins(child) }))
        const ordered = operands.length > 0 && operands.every(operand => operand.offset !== undefined) &&
          new Set(operands.map(operand => operand.offset)).size === operands.length
        const name = node.name || /^\s*(__[a-zA-Z0-9_]*atomic[a-zA-Z0-9_]*)\s*\(/.exec(this.text(node))?.[1]
        if (ordered) operands.sort((left, right) => left.offset! - right.offset!)
        const result: any = this.attach(UAST.callExpression(this.identifier(ordered && name ? name : '__clang_atomic_expr', node),
          operands.map(operand => this.expression(operand.child, context))), node)
        const MEMORY_ORDER = ['relaxed', 'consume', 'acquire', 'release', 'acq_rel', 'seq_cst']
        const isCompareExchange = /compare_exchange/.test(name || '')
        const orderValue = (child: any): number | undefined => {
          if (!child) return undefined
          if (child.kind === 'IntegerLiteral' && child.value !== undefined) {
            const value = Number(child.value)
            if (value >= 0 && value <= 5) return value
          }
          const declared = child.referencedDecl?.name || ''
          const named = /^memory_order_(relaxed|consume|acquire|release|acq_rel|seq_cst)$/.exec(declared)
          if (named) return MEMORY_ORDER.indexOf(named[1])
          for (const inner of child.inner || []) {
            const value = orderValue(inner)
            if (value !== undefined) return value
          }
          return undefined
        }
        const candidates = children.slice(1).map(child => orderValue(child))
          .filter((value: number | undefined): value is number => value !== undefined)
        // compare_exchange carries success/failure orders before the trailing weak flag.
        const memoryOrders = isCompareExchange ? candidates.slice(0, 2)
          : [orderValue(children[1])].filter((value: number | undefined): value is number => value !== undefined)
        result._meta.clangAtomic = { builtin: name, argumentOrder: ordered ? 'source' : 'clang_ast',
          result: /_fetch_(?:add|sub|and|or|xor|nand|min|max)$/.test(name || '') ? 'previous_value' :
            /_(?:add|sub|and|or|xor|nand|min|max)_fetch$/.test(name || '') ? 'updated_value' : 'builtin_defined',
          resultType: node.type?.qualType,
          memoryOrder: memoryOrders.length ? memoryOrders.map(value => ({ value, name: MEMORY_ORDER[value] })) : null }
        if (!memoryOrders.length) {
          this.unsupported.set('atomic_memory_semantics', (this.unsupported.get('atomic_memory_semantics') || 0) + 1)
        }
        if (!ordered || !name) this.unsupported.set('atomic_operand_mapping', (this.unsupported.get('atomic_operand_mapping') || 0) + 1)
        return result
      }
      case 'StmtExpr': {
        const result: any = this.attach(UAST.sequence((children[0]?.inner || []).map(child => this.visit(child, context))), node)
        result._meta.gnuStatementExpression = true
        result._meta.clangStatementExpression = { scope: 'lexical', resultType: node.type?.qualType,
          valueCategory: node.valueCategory }
        if (this.options.language === 'cpp') {
          this.unsupported.set('cpp_statement_expression_lifetime', (this.unsupported.get('cpp_statement_expression_lifetime') || 0) + 1)
        }
        return result
      }
      case 'CompoundLiteralExpr': {
        const result: any = this.attach(UAST.castExpression(this.expression(children[0], context), this.type(node.type?.desugaredQualType || node.type?.qualType)), node)
        result._meta.compoundLiteral = true
        return result
      }
      case 'VAArgExpr': {
        const result: any = this.attach(UAST.callExpression(this.identifier('__builtin_va_arg', node), children.map(child => this.expression(child, context))), node)
        result._meta.typeArguments = [this.type(node.type?.desugaredQualType || node.type?.qualType)]
        return result
      }
      case 'OffsetOfExpr': {
        const result: any = this.attach(UAST.callExpression(this.identifier('offsetof', node), children.map(child => this.expression(child, context))), node)
        // Clang omits the field path from JSON. Retain its exact spelling for consumers.
        result._meta.clangOffsetOf = this.text(node)
        if (children.length) this.unsupported.set('offsetof_index_evaluation', (this.unsupported.get('offsetof_index_evaluation') || 0) + 1)
        return result
      }
      case 'ImplicitValueInitExpr':
      case 'CXXScalarValueInitExpr': {
        const type = node.type?.desugaredQualType || node.type?.qualType || ''
        if (/\[\d+\]/.test(type) && !/\([^)]*\*[^)]*\)\s*\[/.test(type)) return this.initializer({ ...node, kind: 'InitListExpr', array_filler: [
          { ...node, kind: 'ImplicitValueInitExpr', type: { qualType: type.replace(/\[\d+\]/, '') } },
        ] }, context)
        return this.attach(/\*/.test(type) ? UAST.literal(null, 'null') : /bool/.test(type) ? UAST.literal(false, 'boolean') : UAST.literal(0, 'number'), node)
      }
      case 'UnresolvedLookupExpr':
      case 'DependentScopeDeclRefExpr': return this.dependentIdentifier(node)
      case 'CXXDependentScopeMemberExpr':
      case 'UnresolvedMemberExpr': {
        const base = children[0] ? this.expression(children[0], context) : UAST.thisExpression()
        const member = this.identifier(node.member || node.name || this.text(node).split(/::|->|\./).at(-1) || '_', node)
        const expression: any = this.attach(UAST.memberAccess(base, member, false), node)
        expression._meta.clangDependent = true
        this.unsupported.set('dependent_member_resolution', (this.unsupported.get('dependent_member_resolution') || 0) + 1)
        return expression
      }
      case 'UnaryExprOrTypeTraitExpr': {
        const result: any = this.attach(UAST.callExpression(this.identifier(node.name || 'sizeof', node), children.map(child => this.expression(child, context))), node)
        if (node.argType) result._meta.typeArguments = [this.type(node.argType.qualType)]
        return result
      }
      case 'AttributedStmt': {
        const statement = this.statement(children.find(child => !child.kind?.endsWith('Attr')), context)
        statement._meta = { ...statement._meta, clangAttributes: children.filter(child => child.kind?.endsWith('Attr')).map(child => child.kind) }
        return this.attach(statement, node)
      }
      case 'LabelStmt': return this.attach(UAST.labeledStatement(this.identifier(node.name || '_', node), this.statement(children[0], context)), node)
      case 'GotoStmt': {
        const statement: any = this.attach(UAST.noop(), node)
        statement._meta.goto = this.labels.get(node.targetLabelDeclId) || node.targetLabelDeclId
        const target = this.labelOffsets.get(node.targetLabelDeclId)
        const start = this.begins(node)
        statement._meta.gotoTargetOffset = target ?? null
        statement._meta.gotoKind = target === undefined || start === undefined || target === start ? 'unknown'
          : target > start ? 'forward' : 'backward'
        return statement
      }
      case 'StaticAssertDecl': {
        const assertion: any = this.attach(UAST.noop(), node)
        assertion._meta.clangStaticAssert = this.text(node)
        return assertion
      }
      case 'GCCAsmStmt': {
        const text = this.text(node)
        if (!children.length && /^(?:asm|__asm|__asm__)\s*(?:(?:volatile|__volatile|__volatile__)\s*)?\(\s*""\s*\)$/.test(text.trim())) {
          const statement: any = this.attach(UAST.noop(), node)
          statement._meta.emptyInlineAssembly = true
          return statement
        }
        // Clang exposes input operands as child expressions but does not put the
        // assembly template or clobbers in AST JSON. Retain the operand statements
        // and preserve the complete source spelling for consumers; execution
        // semantics remain explicitly unmodeled.
        const statement: any = this.attach(UAST.sequence(children.map(child => this.statement(child, context))), node)
        statement._meta.gnuAsm = { text, volatile: /^(?:asm|__asm|__asm__)\s+(?:volatile|__volatile|__volatile__)\b/.test(text.trim()), modeled: false }
        return statement
      }
      case 'TypeAliasTemplateDecl': return this.attach(UAST.sequence(this.declarations(children.filter(child => child.kind === 'TypeAliasDecl'), context)), node)
      case 'FriendDecl': return this.attach(UAST.sequence(this.declarations(children, { ...context, scopes: context.scopes.slice(0, -1) })), node)
      case 'VarDecl':
      case 'ParmVarDecl':
      case 'FieldDecl': return this.variable(node, context)
      case 'CompoundStmt': return this.attach(UAST.scopedStatement(this.flatten(children.map(child => this.statement(child, context)))), node)
      case 'DeclStmt': return this.attach(UAST.sequence(children.map(child => this.visit(child, context))), node)
      case 'ReturnStmt': return this.attach(UAST.returnStatement(children[0] ? this.expression(children[0], context) : null), node)
      case 'DeclRefExpr': {
        const value = this.enumValues.get(node.referencedDecl?.id)
        if (value !== undefined) return this.attach(UAST.literal(Number.isSafeInteger(Number(value)) ? Number(value) : value, 'number'), node)
        return this.identifier(node.referencedDecl?.name || node.name || '_', node, node.referencedDecl?.id)
      }
      case 'CXXThisExpr': return this.attach(UAST.thisExpression(), node)
      case 'IntegerLiteral': {
        const value = Number(node.value)
        return this.attach(UAST.literal(Number.isSafeInteger(value) ? value : String(node.value), 'number'), node)
      }
      case 'FloatingLiteral': return this.attach(UAST.literal(Number.isFinite(Number(node.value)) ? Number(node.value) : String(node.value), 'number'), node)
      case 'CXXBoolLiteralExpr': return this.attach(UAST.literal(!!node.value, 'boolean'), node)
      case 'CharacterLiteral': return this.attach(UAST.literal(node.value, 'number'), node)
      case 'PredefinedExpr': {
        const predefined: any = children[0] ? this.expression(children[0], context) : this.attach(UAST.literal(node.name || '', 'string'), node)
        predefined._meta = { ...predefined._meta, clangPredefined: node.name || '__func__' }
        return this.attach(predefined, node)
      }
      case 'StringLiteral': {
        try {
          const decoded = decodeClangString(node.value)
          const literal: any = decoded.codeUnits ? this.attach(UAST.objectExpression(
            [...decoded.codeUnits, 0].map((value, index) => UAST.objectProperty(UAST.literal(index, 'number'), UAST.literal(value, 'number'))),
          ), node) : this.attach(UAST.literal(decoded.value, 'string'), node)
          if (decoded.codeUnits) literal._meta.isArray = true
          literal._meta.clangStringEncoding = decoded.encoding
          if (decoded.bytes) literal._meta.clangStringBytes = decoded.bytes
          return literal
        } catch {
          this.unsupported.set('StringLiteralEncoding', (this.unsupported.get('StringLiteralEncoding') || 0) + 1)
          return this.attach(UAST.literal(node.value, 'string'), node)
        }
      }
      case 'CXXNullPtrLiteralExpr':
      case 'GNUNullExpr': return this.attach(UAST.literal(null, 'null'), node)
      case 'ImplicitCastExpr':
      case 'ParenExpr':
      case 'ExprWithCleanups':
      case 'MaterializeTemporaryExpr':
      case 'CXXBindTemporaryExpr':
      case 'ConstantExpr':
      case 'SubstNonTypeTemplateParmExpr': return children[0] ? this.visit(children[0], context) : this.unsupportedNode(node)
      case 'CStyleCastExpr':
      case 'CXXStaticCastExpr':
      case 'CXXReinterpretCastExpr':
      case 'CXXConstCastExpr':
      case 'CXXDynamicCastExpr':
      case 'CXXFunctionalCastExpr': return this.attach(UAST.castExpression(this.expression(children.at(-1), context), this.type(node.type?.qualType)), node)
      case 'BinaryOperator':
      case 'CompoundAssignOperator': {
        const left = this.expression(children[0], context), right = this.expression(children[1], context)
        if (node.opcode === '->*' || node.opcode === '.*') {
          const member: any = this.attach(UAST.memberAccess(left, right, true), node)
          member._meta.cppMemberPointer = node.opcode
          this.unsupported.set('member_pointer_resolution', (this.unsupported.get('member_pointer_resolution') || 0) + 1)
          return member
        }
        if (node.opcode === '=' || node.kind === 'CompoundAssignOperator') {
          const referenceCall = left.type === 'CallExpression' && children[0]?.valueCategory === 'lvalue'
          const dependentTarget = left.type === 'CallExpression' && children[0]?.kind === 'CXXOperatorCallExpr' &&
            children[0]?.type?.qualType === '<dependent type>'
          if (!UAST.isLVal(left) && left.type !== 'DereferenceExpression' && !referenceCall && !dependentTarget) return this.unsupportedNode(node)
          if (dependentTarget) this.unsupported.set('dependent_assignment_target', (this.unsupported.get('dependent_assignment_target') || 0) + 1)
          if (referenceCall) this.unsupported.set('assignment_location_semantics', (this.unsupported.get('assignment_location_semantics') || 0) + 1)
          // Clang lvalues include dereferences and reference-returning calls beyond the shared LVal schema.
          // Preserve both operands while reporting unresolved write-back semantics for calls.
          const assignment = UAST.assignmentExpression(UAST.identifier('_'), right, node.opcode, false)
          assignment.left = left
          if (dependentTarget) assignment._meta = { ...assignment._meta, clangDependentAssignment: true }
          return this.attach(assignment, node)
        }
        return this.attach(UAST.binaryExpression(node.opcode, left, right), node)
      }
      case 'UnaryOperator': {
        const argument = this.expression(children[0], context)
        if (node.opcode === '__extension__') return argument
        const result = node.opcode === '&' ? UAST.referenceExpression(argument)
          : node.opcode === '*' ? UAST.dereferenceExpression(argument)
          : UAST.unaryExpression(node.opcode, argument, !!node.isPostfix)
        return this.attach(result, node)
      }
      case 'ChooseExpr': {
        const condition = children[0]
        const conditionValue = this.enumConstant(condition)
        const selected = conditionValue === undefined ? undefined : conditionValue === 0n ? children[2] : children[1]
        if (selected) {
          const result: any = this.attach(this.expression(selected, context), node)
          result._meta = { ...result._meta, clangChooseExpr: { evaluated: true, selected: conditionValue === 0n ? 'false' : 'true' } }
          return result
        }
        const result: any = this.attach(UAST.conditionalExpression(this.expression(condition, context),
          this.expression(children[1], context), this.expression(children[2], context)), node)
        result._meta.clangChooseExpr = { evaluated: false, selected: 'unknown' }
        return result
      }
      case 'ConditionalOperator': return this.attach(UAST.conditionalExpression(this.expression(children[0], context), this.expression(children[1], context), this.expression(children[2], context)), node)
      case 'PackExpansionExpr': {
        if (children.length !== 1) return this.unsupportedNode(node)
        const result: any = this.attach(UAST.spreadElement(this.expression(children[0], context)), node)
        result._meta.clangPackExpansion = { instantiated: false, expansionCount: node.numExpansions ?? null }
        // Preserve the pattern without pretending a dependent pack is one call
        // or that its cardinality and evaluation have already been resolved.
        this.unsupported.set('PackExpansionExpr', (this.unsupported.get('PackExpansionExpr') || 0) + 1)
        return result
      }
      case 'CallExpr':
      case 'CXXMemberCallExpr': return this.attach(UAST.callExpression(this.expression(children[0], context), this.arguments(children.slice(1), context, this.calleeReference(children[0]).id || '')), node)
      case 'CXXOperatorCallExpr': {
        const callee = this.expression(children[0], context)
        if (callee.name === 'operator()' && children[1]?.type?.qualType?.includes('(lambda at ')) {
          return this.attach(UAST.callExpression(this.expression(children[1], context), this.arguments(children.slice(2), context, this.calleeReference(children[0]).id || '')), node)
        }
        const reference = this.calleeReference(children[0])
        return this.attach(UAST.callExpression(callee, this.arguments(children.slice(1), context, reference.id || '', reference.kind === 'CXXMethodDecl' ? -1 : 0)), node)
      }
      case 'MemberExpr': {
        const result: any = this.attach(UAST.memberAccess(this.expression(children[0], context), this.identifier(node.name || '_', { ...node, range: { begin: node.range?.end, end: node.range?.end } }, node.referencedMemberDecl), false), node)
        if (node.isArrow) result._meta.pointer = true
        return result
      }
      case 'ArraySubscriptExpr': return this.attach(UAST.memberAccess(this.expression(children[0], context), this.expression(children[1], context), true), node)
      case 'CXXNewExpr': {
        const construction = children.length === 1 && children[0].kind === 'CXXConstructExpr' ? children[0] : undefined
        const result: any = construction ? this.expression(construction, context) : this.attach(UAST.newExpression(
          this.identifier((node.type?.qualType || '_').replace(/\s*\*$/, ''), node), children.map(child => this.expression(child, context)),
        ), node)
        result._meta.clangAllocation = { array: !!node.isArray, placement: !!node.isPlacement, operator: node.operatorNewDecl?.name }
        this.unsupported.set('cpp_allocation_semantics', (this.unsupported.get('cpp_allocation_semantics') || 0) + 1)
        return this.attach(result, node)
      }
      case 'CXXDeleteExpr': {
        const result: any = this.attach(UAST.sequence(children.map(child => this.expression(child, context))), node)
        result._meta.clangDelete = { array: !!node.isArray, operator: node.operatorDeleteDecl?.name }
        this.unsupported.set('cpp_delete_semantics', (this.unsupported.get('cpp_delete_semantics') || 0) + 1)
        return result
      }
      case 'CXXUnresolvedConstructExpr':
      case 'CXXConstructExpr':
      case 'CXXTemporaryObjectExpr': {
        if (node.kind === 'CXXUnresolvedConstructExpr') this.unsupported.set('dependent_construction', (this.unsupported.get('dependent_construction') || 0) + 1)
        const arguments_ = children.flatMap(child => child.kind === 'ParenListExpr' ? child.inner || [] : [child])
        return this.attach(UAST.newExpression(this.identifier(node.type?.qualType || '_', node), this.arguments(arguments_, context, (node.type?.desugaredQualType || node.type?.qualType) + '|' + node.ctorType?.qualType)), node)
      }
      case 'LambdaExpr': return this.lambda(node, context)
      case 'IfStmt': {
        const parts = [...children]
        const alternative = node.hasElse ? parts.pop() : undefined
        const consequent = parts.pop()
        const condition = parts.pop()
        const result = this.attach(UAST.ifStatement(this.expression(condition, context), this.statement(consequent, context), alternative ? this.statement(alternative, context) : null), node)
        return parts.length ? this.attach(UAST.scopedStatement([...this.flatten(parts.map(child => this.statement(child, context))), result]), node) : result
      }
      case 'CaseStmt':
      case 'DefaultStmt': {
        // Labels nested inside a compound statement cannot be flattened without
        // changing scope and dispatch. Retain the subtree and report that gap.
        let name = '__yasa_nested_case_' + (this.begins(node) ?? 0)
        while (this.options.raw.includes(name)) name += '_'
        const result: any = this.attach(UAST.labeledStatement(this.identifier(name, node), this.statement(children.at(-1), context)), node)
        result._meta.clangCaseTest = node.kind === 'CaseStmt' ? this.expression(children[0], context) : null
        if (node.isGNURange) result._meta.clangCaseRange = { upper: this.expression(children[1], context), expanded: false }
        result._meta.clangNestedSwitchLabel = true
        this.unsupported.set('nested_switch_label_control_flow', (this.unsupported.get('nested_switch_label_control_flow') || 0) + 1)
        return result
      }
      case 'SwitchStmt': return this.switch(node, context)
      case 'CXXForRangeStmt': return this.range(node, context)
      case 'CXXTryStmt': return this.attach(UAST.tryStatement(this.statement(children[0], context), children.slice(1).map(child => this.visit(child, context))), node)
      case 'CXXCatchStmt': {
        const parameter = children[0]?.kind ? this.variable(children[0], context) : null
        const clause: any = this.attach(UAST.catchClause(parameter ? [parameter] : [], this.statement(children.at(-1), context)), node)
        if (!parameter) clause._meta.cppCatchAll = true
        return clause
      }
      case 'CXXThrowExpr': return this.attach(UAST.throwStatement(children[0] ? this.expression(children[0], context) : null), node)
      case 'WhileStmt': {
        const condition = this.expression(children.at(-2), context)
        const declarations = children.slice(0, -2).map(child => this.visit(child, context))
        const test = declarations.length ? UAST.sequence([...this.flatten(declarations), condition]) : condition
        return this.attach(UAST.whileStatement(test, this.statement(children.at(-1), context), false), node)
      }
      case 'DoStmt': {
        const result: any = this.attach(UAST.whileStatement(this.expression(children[1], context), this.statement(children[0], context), true), node)
        if (node.yasaBackedge) result._meta.clangStructuredBackedge = node.yasaBackedge
        return result
      }
      case 'ForStmt': {
        const condition = children[2]?.kind ? this.expression(children[2], context) : null
        const test = children[1]?.kind ? UAST.sequence([...this.flatten([this.visit(children[1], context)]), condition]) : condition
        return this.attach(UAST.forStatement(children[0]?.kind ? this.visit(children[0], context) : null, test, children[3]?.kind ? this.expression(children[3], context) : null, this.statement(children[4], context)), node)
      }
      case 'BreakStmt': return this.attach(UAST.breakStatement(), node)
      case 'ContinueStmt': return this.attach(UAST.continueStatement(), node)
      case 'EmptyDecl': {
        const empty: any = this.attach(UAST.noop(), node)
        empty._meta.emptyDeclaration = true
        return empty
      }
      case 'NullStmt':
      case 'AccessSpecDecl':
      case 'TypedefDecl':
      case 'TypeAliasDecl': {
        const alias: any = this.attach(UAST.noop(), node)
        alias._meta.typedef = { name: node.name, type: this.type(node.type?.desugaredQualType || node.type?.qualType) }
        return alias
      }
      case 'NamespaceAliasDecl': {
        const result: any = this.attach(UAST.noop(), node)
        // Clang references carry their resolved declaration IDs; aliases have no
        // runtime operation, but keep the source-level relationship for consumers.
        result._meta.clangNamespaceAlias = { name: node.name, target: node.aliasedNamespace }
        return result
      }
      case 'UsingDecl':
      case 'UsingDirectiveDecl':
      case 'NonTypeTemplateParmDecl':
      case 'TemplateTypeParmDecl':
      case 'TemplateArgument': return this.attach(UAST.noop(), node)
      default: return this.unsupportedNode(node)
    }
  }

  add(node: Ast): void {
    if (node.isImplicit || !this.includesDeclaration(node)) return
    this.body.push(...this.flatten([this.visit(node)]))
  }

  finish(): any {
    for (const pending of this.pendingDefaults) {
      const value = this.parameterDefaults.get(pending.key)?.[pending.parameterIndex]
      const key = pending.key + ':' + pending.parameterIndex
      if (value && !pending.context.defaultStack?.includes(key)) {
        pending.arguments[pending.index] = this.expression(value.node, {
          ...value.context, defaultStack: [...(pending.context.defaultStack || []), key],
        })
      } else this.unsupported.set('CXXDefaultArgExpr', (this.unsupported.get('CXXDefaultArgExpr') || 0) + 1)
    }
    const result: any = UAST.compileUnit(this.body, 'php' as any, this.options.languageVersion || (this.options.language === 'c' ? 'c11' : 'c++17'), this.options.sourcefile, '0.0.0')
    result.language = this.options.language
    result.loc = { sourcefile: this.options.sourcefile, start: { line: 1, column: 1 }, end: this.coordinates.location(this.bytes.length) }
    result._meta = { ...result._meta, parseErrors: [], clangBackend: { status: this.unsupported.size ? 'partial' : 'converted', unsupported: Object.fromEntries(this.unsupported), semanticCoverage: 'experimental_subset', input: 'compiler_preprocessed', locationSpace: 'preprocessed' } }
    return result
  }
}

/** Stream top-level declarations so system headers do not require a full AST JSON in memory. */
export async function convertClangAstFile(file: string, options: ClangUastOptions): Promise<any> {
  if (!options.validated) await readCompilerDeclarations(file)
  const JSONStream = require('JSONStream')
  const converter = new ClangUastConverter(options)
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(file)
    const parser = JSONStream.parse('inner.*')
    const fail = (error: Error) => { input.destroy(); parser.destroy(); reject(error) }
    input.on('error', fail)
    parser.on('error', fail)
    parser.on('data', (node: Ast) => {
      try { converter.add(node) } catch (error) { fail(error as Error) }
    })
    parser.on('end', () => resolve(converter.finish()))
    input.pipe(parser)
  })
}
