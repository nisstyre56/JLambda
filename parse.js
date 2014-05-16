#! /usr/bin/node
var fs = require("fs");
var typ = require("./representation.js");
var $ = require("./tools.js");
var _ = require("underscore");
var tokenizer = require("./tokenize.js");
var desugarer = require("./desugar.js");
var pprint = require("./pprint.js");
var error = require("./errors.js");

var print = console.log;

function sourcePos(tokens, linenum, charnum) {
  if (!tokens || tokens.length === 0) {
    return { linenum : linenum,
             charnum : charnum
    };
  }
  return {
    linenum : fst(tokens)[3],
    charnum : fst(tokens)[2]
  };
}

function addSrcPos(stx, tokens, linenum, charnum) {
  var pos = sourcePos(tokens, linenum, charnum);
  stx.linenum = pos.linenum;
  stx.charnum = pos.charnum;
  return stx;
}

function fst(ts) {
  return ts[ts.length-1];
}

function snd(ts) {
  return ts[ts.length-2];
}

/*Checks if the next token is not followed by any of ``checks'' */
function notFollowedBy(tokens, checks, linenum, charnum) {
  if (!fst(tokens)) {
    throw error.JSyntaxError(0,0,"unexpected end of source");
  }
  var nextT = fst(tokens)[0];
  if (checks.some(function (x) {
    return x === nextT;
  }))
    return false;
  else
    return true;
}

/* returns a function that takes a parameter and
   checks if it is in the array ``props''*/
function makeChecker(props) {
  return function(x) {
    return x && props.some(function (y) {return y(x);});
  };
}

function tokTypeCheck(name) {
  return function(tok) {
    return tok[0] === name;
  };
}

function formTypeCheck(stxtype) {
  return function(stx) {
    return stx.exprType === stxtype;
  };
}

/*Tries to parse until the prediction ``valid'' fails or the wrong type is parsed
  Collects the results into an array and returns it*/
function parseMany(parse, exprType, valid, tokens, charnum, linenum) {
  if (!fst(tokens)) {
    throw error.JSyntaxError(charnum,
                             linenum,
                             "Unexpected end of source");
  }
  var current = fst(tokens)[0];
  var results = [];
  var parsed;

  if (valid(fst(tokens))) {
    parsed = parse(tokens);
  }
  else {
    throw error.JSyntaxError(fst(tokens)[3],
                             fst(tokens)[2],
                             "Unexpected token: ``"+fst(tokens)[0]+"''");
  }
  results.push(parsed);

  //make sure there are at least 2 tokens to parse
  if (tokens.length > 1 && fst(tokens) && valid(fst(tokens))) {
    while (valid(snd(tokens))) {
      if (!(valid(fst(tokens)))) {
        break;
      }
      results.push(parse(tokens));
      if (!exprType(fst(results).exprType)) {
        break;
      }
      if (fst(tokens)) {
        current = fst(tokens)[0];
      }
      else {
        throw error.JSyntaxError(linenum,
                                 charnum,
                                 "Unexpected end of source");
      }
      if (tokens.length <= 1) {
        break;
      }
    }
  }
  //do the same validity check as before and in the loop
  if (!fst(tokens)) {
    throw error.JSyntaxError(fst(tokens)[3],
                             fst(tokens)[2],
                             "unexpected end of source");
  }
  if (valid(fst(tokens))) {
    results.push(parse(tokens));
  }
  return results;
}


/* Tries to parse exprType separated by the token between
 * e.g. <identifier>,<identifier>,...
 */
function parseBetween(exprType, between, tokens, charnum, linenum) {
  var first = parse(tokens);
  if (!exprType(first)) {
    throw error.JSyntaxError(fst(tokens)[2], fst(tokens)[3], "Unexpected token: ``"+fst(tokens)[0]+"''");
  }
  var items = [first];
  var parsed;
  if (tokens.length > 1 && fst(tokens)[0] === between) {
    while (fst(tokens)[0] === between) {
      tokens.pop();
      parsed = parse(tokens);
      if (!fst(tokens))
        throw error.JSyntaxError(fst(tokens)[3],
                                 fst(tokens)[2],
                                 "Missing terminator: "+between);
      items.push(parsed);
    }
    return items;
  }
  return items;
}

function parseList(tokens, linenum, charnum) {
  var xs;
  var result;
  if (fst(tokens)[0] === "right_square") {
      xs = [];
  }
  else if (fst(tokens)[0] === "comma") {
    tokens.pop();
    xs = [];
  }
  else {
    xs = parseBetween(function (x) {
      return true;
    }, "comma", tokens, fst(tokens)[3], fst(tokens)[2]);
  }
  if (!fst(tokens) || fst(tokens)[0] !== "right_square") {
    throw error.JSyntaxError(fst(tokens)[3],
                             fst(tokens)[2],
                             "list must be terminated by ]");
  }
  tokens.pop();
  result = addSrcPos(new typ.ListT(xs), tokens, linenum, charnum);
  return result;
}


function parseDefFunction(tokens, linenum, charnum) {
  var fname = parse(tokens);
  var parameters;
  var result;
  if (fname.exprType !== "Name") {
    throw error.JSyntaxError(fst(tokens)[3],
                             fst(tokens)[2],
                             "Expected an identifier in function definition");
  }
  if (fst(tokens)[0] === "right_paren") {
    parameters = [];
  }
  else {
    parameters = parseMany(parse,
                           validName,
                           validFormPar,
                           tokens,
                           fst(tokens)[2],
                           fst(tokens)[3]);
  }
  if ((fst(tokens)[0]) !== "right_paren") {
    throw error.JSyntaxError(fst(tokens)[3],
                             fst(tokens)[2],
                             "Formal parameters must be followed by )");
  }
  tokens.pop();
  var body = parse(tokens);
  result = addSrcPos(new typ.DefFunc(fname, parameters, body), tokens, linenum, charnum);
  return result;
}

validLet = makeChecker(["Definition", "FunctionDefinition"].map(formTypeCheck));
letEnd = _.compose($.not, makeChecker(["right_brace"].map(tokTypeCheck)));

function parseLetForm(tokens, linenum, charnum) {
  var result;

  if (!fst(tokens)) {
    error.JSyntaxError(linenum,
                       charnum,
                       "Unexpected end of source");
  }
  var pairs = parseMany(parseLetItem,
                        validLet,
                        letEnd,
                        tokens,
                        linenum,
                        charnum);
  if (fst(tokens) && fst(tokens)[0] !== "right_brace") {
    throw error.JSyntaxError(fst(tokens)[2],
                             fst(tokens)[3],
                             "let/def form must have a closing }");
  }
  if (!fst(tokens)) {
    throw error.JSyntaxError(linenum,
                             charnum,
                             "Unexpected end of source");
  }
  tokens.pop();
  if (tokens.length <= 0) {
    throw error.JSyntaxError(fst(tokens)[3],
                             fst(tokens)[2],
                             "let/def form must have a body");
  }
  var body = parse(tokens);
  if (body.exprType === "Definition" ||
      body.exprType === "FunctionDefinition") {
        throw error.JSyntaxError(fst(tokens)[3],
                                 fst(tokens)[2],
                                 "Body of a let/def expression cannot be a definition");
      }
  result = addSrcPos(new typ.LetExp(pairs, body), tokens, linenum, charnum);
  return result;

}

function parseLetFunction(tokens, linenum, charnum) {
  var fname = parse(tokens);
  var parameters;
  var result;

  if (fname.exprType != "Name") {
    throw error.JSyntaxError(fst(tokens)[3],
                             fst(tokens)[2],
                             "Expected an identifier in function definition");
  }
  if (fst(tokens)[0] === "right_paren") {
    parameters = [];
  }
  else {
    parameters = parseMany(parse,
                           validName,
                           validFormPar,
                           tokens,
                           fst(tokens)[2],
                           fst(tokens)[3]);
  }
  if ((fst(tokens)[0]) !== "right_paren") {
    throw error.JSyntaxError(fst(tokens)[3],
                             fst(tokens)[2],
                             "Formal parameters must be followed by )");
  }
  tokens.pop();
  if (fst(tokens)[1] !== "->") {
    throw error.JSyntaxError(fst(tokens)[3],
                             fst(tokens)[2],
                             "Function parameters in let/def form must be followed by ->");
  }
  tokens.pop();
  var body = parse(tokens);
  result = addSrcPos(new typ.DefFunc(fname, parameters, body), tokens, linenum, charnum);
  return result;
}

function parseLetBinding(tokens, linenum, charnum) {
  var name = parse(tokens);
  var result;

  if (name.exprType != "Name") {
    throw error.JSyntaxError(linenum,
                             charnum,
                             "Expected an identifier in let/def binding");
  }
  if (!fst(tokens) || fst(tokens)[1] !== "=") {
    throw error.JSyntaxError(linenum,
                             charnum,
                             "An identifier in a let/def binding must be followed by ``=''");
  }
  tokens.pop();
  if (!notFollowedBy(tokens,
                       ["comma", "arrow", "right_brace", "right_square"],
                       linenum,
                       charnum)) {
      throw error.JSyntaxError(linenum,
                               charnum,
                               "The binding of " + identifier.val + " must not be followed by " + fst(tokens)[0]);
                       }
  var bound = parse(tokens);
  if (bound.exprType === "Definition" ||
      bound.exprType === "FunctionDefinition") {
        throw error.JSyntaxError(linenum,
                                 charnum,
                                 "A definition cannot be the value of a binding");
      }
  result = addSrcPos(new typ.Def(name, bound), tokens, linenum, charnum);
  return result;
}

function parseLetItem(tokens) {
  if (fst(tokens) && fst(tokens)[0] === "left_paren") {
    tokens.pop();
    return parseLetFunction(tokens,
                            fst(tokens)[3],
                            fst(tokens)[2]);
  }
  else {
    return parseLetBinding(tokens,
                           fst(tokens)[3],
                           fst(tokens)[2]);
  }
}

function parseDef(tokens, linenum, charnum) {
  var result;

  if (tokens.length < 2)
    throw error.JSyntaxError(linenum,
                             charnum,
                             "Unexpected end of source");
  if (fst(tokens)[0] === "left_paren") {
    /* It's a function definition */
    tokens.pop();
    return parseDefFunction(tokens, linenum, charnum);
  }

  if (fst(tokens)[0] === "left_brace") {
    /* It's a let/def form */
    tokens.pop();
    return parseLetForm(tokens,
                        fst(tokens)[3],
                        fst(tokens)[2]);
  }

  if (notFollowedBy(tokens, ["identifier"], linenum, charnum)) {
    throw error.JSyntaxError(linenum,
                             charnum,
                             "def must be followed by identifier, not "+fst(tokens)[0]);
  }
  else {
    var identifier = parse(tokens);
    if (!fst(tokens))
      throw error.JSyntaxError(linenum,
                               charnum,
                               "Unexpected end of source");
    linenum = fst(tokens)[3];
    charnum = fst(tokens)[2];
    if (!notFollowedBy(tokens,
                       ["comma", "arrow", "right_brace", "right_square"],
                       linenum,
                       charnum)) {
      throw error.JSyntaxError(linenum,
                               charnum,
                               "def " + identifier.val + " must not be followed by " + fst(tokens)[0]);
    }
    var bound = parse(tokens);
    if (bound.exprType === "Definition" ||
      bound.exprType === "FunctionDefinition") {
        throw error.JSyntaxError(linenum,
                                 charnum,
                                 "A definition cannot be the value of a binding");
      }
    result = addSrcPos(new typ.Def(identifier, bound), tokens, linenum, charnum);
    return result;
  }
 }

function parseDefOp(tokens, linenum, charnum) {
  var result;
  var names;

  if (fst(tokens)[0] !== "integer" ||
      fst(tokens)[1] < 1) {
    throw error.JSyntaxError(linenum,
                             charnum,
                             "defop must be followed by integer precedence >= 1");
      }
  tokens.pop();

  if (fst(tokens)[1] !== "Left" && fst(tokens)[1] !== "Right") {
         throw error.JSyntaxError(linenum,
                                  charnum,
                                  "defop must be followed by precedence and then either Left or Right");
       }
  tokens.pop();
  if (fst(tokens)[0] !== "left_paren") {
    throw error.JSyntaxError(linenum,
                             charnum,
                             "defop arguments must start with (");
  }
  tokens.pop();
  if (!(tokens.slice(tokens.length-3,
                    tokens.length).every(function(x) {
                      return x[0] === "identifier";
                    }))) {
    throw error.JSyntaxError(linenum,
                             charnum,
                             "defop must be surrounded by exactly 3 identifiers");
    }
  var pattern = tokens.slice(tokens.length-3,
                             tokens.length);
  tokens.pop(); tokens.pop(); tokens.pop();
  if (fst(tokens)[0] !== "right_paren") {
    throw error.JSyntaxError(linenum,
                             charnum,
                             "defop pattern must be terminated with )");
  }
  tokens.pop();
  names = [new typ.Name(pattern[1][1]),
           new typ.Name(pattern[0][1]),
           new typ.Name(pattern[2][1])];
  names.map(function(name) {
    name.linenum = linenum;
    name.charnum = charnum;
    return name;
  });

  result = addSrcPos(new typ.DefFunc(names[0],
                                    names.slice(1,3),
                                    parse(tokens)),
                     tokens,
                     linenum,
                     charnum);
  return result;
}



function parseIf(tokens) {
  var linenum = fst(tokens)[3];
  var charnum = fst(tokens)[2];
  var result;
  if (!notFollowedBy(tokens,
                     ["def","comma","lambda"],
                     linenum,
                     charnum)) {
    throw error.JSyntaxError(linenum,
                             charnum,
                             "``if'' cannot be followed by "+fst(tokens)[0]) ;
  }
  else {
    var ifC = parse(tokens);
    if (!fst(tokens) || fst(tokens)[0] !== "thenexp") {
      throw error.JSyntaxError(fst(tokens)[3],
                               fst(tokens)[2],
                               "if ``exp'' must be folowed by ``then'' exp, not "+snd(tokens)[0]);
    }
    else {
      tokens.pop();
      var thenC = parse(tokens);

      if (fst(tokens) && fst(tokens)[0] === "elsexp") {
        tokens.pop();
        if (_.size(tokens) < 1) {
          throw error.JSyntaxError(linenum,
                                   charnum,
                                   "Unexpected end of source");
        }
      else {
        var elseC = parse(tokens);
        result = addSrcPos(new typ.If(ifC, thenC, elseC), tokens, linenum, charnum);
        return result;
        }
      }
      else {
        throw error.JSyntaxError(linenum,
                                 charnum,
                                 "If expression must include an else variant");
      }
    }
  }
}

var validName = makeChecker(["Name"].map(formTypeCheck));

function validFormPar(tok) {
  return tok[0] === "identifier" &&
         tok[1] !== "->";
}

function parseLambda(tokens) {
  var linenum = fst(tokens)[2];
  var charnum = fst(tokens)[3];
  var result;
  var parameters = parseMany(parse,
                             validName,
                             validFormPar,
                             tokens,
                             charnum,
                             linenum);
  if (fst(tokens)[1] !== "->") {
    throw error.JSyntaxError(fst(tokens)[3],
                             fst(tokens)[2],
                             "arrow must follow parameters in lambda, not "+fst(tokens)[0]);
  }
  tokens.pop();
  var body = parse(tokens);
  result = addSrcPos(new typ.FuncT(parameters, body), tokens, linenum, charnum);
  return result;
}

var invalidArguments = ["def", "comma", "right_paren", "right_square", "right_brace", "left_brace", "right_brace"].map(tokTypeCheck);
var validArgument = _.compose($.not, makeChecker(invalidArguments));
var validArgTypes = _.compose($.not, makeChecker(["Definition"].map(formTypeCheck)));

/* Parses function application (either infix or prefix) */
function computeApp(tokens, charnum, linenum) {
  var lhs = parse(tokens);
  var next;
  var result;
  if (fst(tokens)) {
    next = fst(tokens);
  }
  else {
    throw error.JSyntaxError(linenum,
                             charnum,
                             "Unexpected end of source");
  }
  if (typ.OPInfo[next[1]]) {
    /* it's an infix expression */
    result = parseInfix(tokens, 1, lhs, linenum, charnum);
    if (!fst(tokens) || fst(tokens)[0] !== "right_paren") {
      throw error.JSyntaxError(fst(tokens)[3],
                               fst(tokens)[2],
                               "Mismatched parentheses or missing parenthesis on right-hand side");
    }
    else {
      tokens.pop();
      return result;
    }
  }
  else {
    /* it's a prefix application */
    var parameters;
    if (fst(tokens)[0] !== "right_paren") {
      parameters = parseMany(parse,
                             validArgTypes,
                             validArgument,
                             tokens,
                             fst(tokens)[2],
                             fst(tokens)[3]);
    }
    else {
      parameters = [];
    }
    if ((!fst(tokens)) || fst(tokens)[0] !== "right_paren") {
      throw error.JSyntaxError(fst(tokens)[3],
                               fst(tokens)[2],
                               "Mismatched parentheses or missing parenthesis on right-hand side");
    }
    else {
      tokens.pop();
      return addSrcPos(typ.makeApp(lhs, parameters), tokens, linenum, charnum);
    }
  }
}

/*Parses infix expressions by precedence climbing
 * console.log(stx);
  See this for more info and an implementation in python
  http://eli.thegreenplace.net/2012/08/02/parsing-expressions-by-precedence-climbing/
*/
function parseInfix(tokens, minPrec, lhs, linenum, charnum) {
  if (!lhs) {
    lhs = parse(tokens);
  }
  while (true) {
    var cur = fst(tokens);
    if (!cur) {
      throw error.JSyntaxError(linenum,
                               charnum,
                               "Unexpected end of source");
    }
    var opinfo = typ.OPInfo[cur[1]];

    if (!opinfo || opinfo[0] < minPrec)
      break;

    var op = addSrcPos(new typ.Name(cur[1]), tokens, linenum, charnum);
    var prec = opinfo[0];
    var assoc = opinfo[1];
    var nextMinPrec = assoc === "Left" ? prec + 1 : prec;
    tokens.pop();
    /*remove the operator token*/
    var rhs = parseInfix(tokens, nextMinPrec);
    lhs = addSrcPos(typ.makeApp(op, [lhs, rhs]), tokens, linenum, charnum);
  }
  return lhs;
}

function parse(tokens) {
  var charnum = fst(tokens)[2];
  var linenum = fst(tokens)[3];
  var toktype;
  var result;
  if (fst(tokens)) {
    toktype = fst(tokens)[0];
  }
  else {
    process.exit(code=1);
  }
  var token = fst(tokens)[1];
  tokens.pop();
  if (toktype === "stringlit") {
    result = addSrcPos(new typ.StrT(token), tokens, linenum, charnum);
    return result;
  }
  else if (toktype === "left_square") {
    return parseList(tokens, linenum, charnum);
  }
  else if (toktype === "lambda") {
    return parseLambda(tokens);
  }
  else if (toktype === "integer") {
    result = addSrcPos(new typ.IntT(token), tokens, linenum, charnum);
    return result;
  }
  else if (toktype === "float") {
    result = addSrcPos(new typ.FloatT(token), tokens, linenum, charnum);
    return result;
  }
  else if (toktype === "identifier") {
    result = addSrcPos(new typ.Name(token), tokens, linenum, charnum);
    return result;
  }
  else if (toktype === "constructor") {
    result = addSrcPos(new typ.TypeOp(token), tokens, linenum, charnum);
    return result;
  }
  else if (toktype === "truelit" || toktype === "falselit") {
    result = addSrcPos(new typ.BoolT(token), tokens, linenum, charnum);
    return result;
  }
  else if (toktype === "def" ||
           toktype === "let") {
    return parseDef(tokens, linenum, charnum);
  }
  else if (toktype === "defop") {
    return parseDefOp(tokens, linenum, charnum);
  }
  else if (toktype === "ifexp") {
    return parseIf(tokens);
  }
  else if (toktype === "left_paren") {
    if (fst(tokens)[0] === "lambda") {
      tokens.pop();
      var parsed = parseLambda(tokens);
      tokens.pop();
      return parsed;
    }
    else
      return computeApp(tokens, linenum, charnum);
  }
  else {
    throw error.JSyntaxError(linenum,
                             charnum,
                             "Unexpected token: ``" + toktype+"''");
  }
}


function parseFull(tokenized) {
  var ast = [];
  try {
    while (tokenized.length > 0) {
      var parsed = desugarer.desugar(parse(tokenized));
      ast.push(parsed);
    }
    return ast;
  } catch (e) {
      if (e.stxerror !== undefined) {
        e.stxerror();
      }
      else {
        console.log(e.errormessage);
      }
      process.exit(1);
  }
}

module.exports = { parse : function(str) {
                              return parseFull(tokenizer.tokenize(str));
                            },
                  tokenize : tokenizer.tokenize
                 };
var istr = fs.readFileSync('/dev/stdin').toString();
console.log(parseFull(tokenizer.tokenize(istr)).map(pprint.pprint));
