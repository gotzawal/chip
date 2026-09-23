import sys
data=open(sys.argv[1],'rb').read()
def leb(b,p):
    r=0;s=0
    while True:
        x=b[p];p+=1
        r|=(x&0x7f)<<s;s+=7
        if x<0x80: return r,p
def sleb(b,p):
    r=0;s=0
    while True:
        x=b[p];p+=1
        r|=(x&0x7f)<<s;s+=7
        if x<0x80:
            if x&0x40: r-= (1<<s)
            return r,p
p=8; nimp=0; exports={}; code_start=None; types=[]
while p<len(data):
    sid=data[p];p+=1
    sz,p=leb(data,p); end=p+sz
    if sid==2:
        n,q=leb(data,p)
        for i in range(n):
            ml,q=leb(data,q); q+=ml
            fl,q=leb(data,q); fld=data[q:q+fl].decode(); q+=fl
            kind=data[q]; q+=1
            if kind==0:
                _,q=leb(data,q); exports.setdefault(nimp,'import:'+fld); nimp+=1
            elif kind==1:
                q+=1; fl2=data[q]; q+=1; _,q=leb(data,q)
                if fl2&1: _,q=leb(data,q)
            elif kind==2:
                fl2=data[q]; q+=1; _,q=leb(data,q)
                if fl2&1: _,q=leb(data,q)
            elif kind==3: q+=2
            elif kind==4: q+=1; _,q=leb(data,q)
    if sid==7:
        n,q=leb(data,p)
        for i in range(n):
            nl,q=leb(data,q); nm=data[q:q+nl].decode(); q+=nl
            kind=data[q]; q+=1
            idx,q=leb(data,q)
            if kind==0: exports.setdefault(idx,nm)
    if sid==10: code_start=p
    p=end
# decode code section
p=code_start
n,p=leb(data,p)
bodies={}
for i in range(n):
    sz,p=leb(data,p); bodies[nimp+i]=(p,p+sz); p+=sz
def calls(fidx):
    s,e=bodies[fidx]; p=s
    nloc,p=leb(data,p)
    for _ in range(nloc):
        _,p=leb(data,p); p+=1
    out=[]
    while p<e:
        op=data[p];p+=1
        if op in (0x02,0x03,0x04):
            bt=data[p]
            if bt==0x40 or bt in (0x7f,0x7e,0x7d,0x7c,0x7b,0x70,0x6f): p+=1
            else: _,p=sleb(data,p)
        elif op in (0x0c,0x0d): _,p=leb(data,p)
        elif op==0x0e:
            n2,p=leb(data,p)
            for _ in range(n2+1): _,p=leb(data,p)
        elif op==0x10:
            t,p=leb(data,p); out.append(('call',t))
        elif op==0x11:
            _,p=leb(data,p); _,p=leb(data,p); out.append(('call_indirect',None))
        elif op in (0x20,0x21,0x22,0x23,0x24,0x25,0x26): _,p=leb(data,p)
        elif op==0x1c:
            n2,p=leb(data,p); p+=n2
        elif 0x28<=op<=0x3e: _,p=leb(data,p); _,p=leb(data,p)
        elif op in (0x3f,0x40): p+=1
        elif op==0x41: _,p=sleb(data,p)
        elif op==0x42: _,p=sleb(data,p)
        elif op==0x43: p+=4
        elif op==0x44: p+=8
        elif op==0xd0: p+=1
        elif op==0xd2: _,p=leb(data,p)
        elif op==0xfc:
            sub,p=leb(data,p)
            if sub<=7: pass
            elif sub==8: _,p=leb(data,p); p+=1
            elif sub==9: _,p=leb(data,p)
            elif sub==10: p+=2
            elif sub==11: p+=1
            elif sub in (12,14): _,p=leb(data,p); _,p=leb(data,p)
            elif sub==13: _,p=leb(data,p)
            elif sub in (15,16,17): _,p=leb(data,p)
            else: raise Exception('fc %d'%sub)
        elif op==0xfd: raise Exception('simd at %d'%p)
        elif op in (0x00,0x01,0x05,0x0b,0x0f,0x1a,0x1b) or 0x45<=op<=0xc4: pass
        else: raise Exception('unknown op %x at %d in f%d'%(op,p,fidx))
    return out
for a in sys.argv[2:]:
    f=int(a)
    cs=calls(f)
    print('== f%d %s'%(f,exports.get(f)))
    seen=[]
    for k,t in cs:
        nm=exports.get(t,'?') if t is not None else ''
        seen.append('%s %s %s'%(k,t,nm))
    for s in seen: print('  ',s[:200])
